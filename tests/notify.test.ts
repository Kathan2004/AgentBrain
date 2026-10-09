import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { initStore } from "../src/core/store.js";
import { defaultNotificationSender, notificationCommand, watchNotifications } from "../src/core/notify.js";
import { tempRepo } from "./helpers.js";

/** Waits until `check` passes (file watching is slower on busy CI machines), up to 10 s. */
async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 10_000;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

describe("task notifications", () => {
  it("notifies once when a task moves to review", async () => {
    const repo = tempRepo("agentbrain-notify-");
    initStore(repo);
    const task = createTask(repo, "Review the change");
    const sent: [string, string][] = [];
    const stop = watchNotifications(repo, (title, message) => sent.push([title, message]));
    try {
      updateTask(repo, task.id, { status: "review" });
      await eventually(() => sent.length > 0);
      expect(sent).toEqual([[`Task review: ${task.id}`, task.objective]]);

      // Nothing changes from here: no repeat notification, even across a poll.
      await new Promise((r) => setTimeout(r, 3500));
      expect(sent).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

const decodeScript = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
/** The base64 literals the script decodes back into the title and text. */
const decodedStrings = (script: string) =>
  [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8"));

describe("desktop notification commands", () => {
  const nasty = `it's "done" $(rm -rf /); & echo \u2019pwned\u2019 \`n -flag`;

  it("uses osascript on macOS", () => {
    expect(notificationCommand("darwin", "Task review", "Fix it")).toEqual({
      command: "osascript",
      args: ["-e", 'display notification "Fix it" with title "Task review"'],
    });
  });

  it("uses notify-send on Linux when it is on PATH", () => {
    const find = (command: string) => (command === "notify-send" ? "/usr/bin/notify-send" : null);
    expect(notificationCommand("linux", "-Task", nasty, find)).toEqual({
      command: "/usr/bin/notify-send",
      args: ["--", "-Task", nasty],
    });
    expect(notificationCommand("linux", "Task", "text", () => null)).toBeNull();
  });

  it("uses an encoded PowerShell script on Windows", () => {
    const find = (command: string) => (command === "powershell" ? "C:\\Windows\\powershell.exe" : null);
    const result = notificationCommand("win32", nasty, "line one\nline two", find)!;
    expect(result.command).toBe("C:\\Windows\\powershell.exe");
    expect(result.args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand"]);
    expect(result.args.at(-1)).toMatch(/^[A-Za-z0-9+/=]+$/);
    const script = decodeScript(result.args);
    expect(script).toContain("Windows.UI.Notifications.ToastNotificationManager");
    expect(script).toContain("System.Windows.Forms.NotifyIcon");
    // The text only ever appears base64-encoded inside the script.
    expect(script).not.toContain("rm -rf");
    expect(decodedStrings(script)).toEqual([nasty, "line one\nline two"]);
  });

  it("falls back to pwsh, then to nothing, on Windows", () => {
    expect(notificationCommand("win32", "a", "b", (c) => (c === "pwsh" ? "C:\\pwsh.exe" : null))?.command).toBe("C:\\pwsh.exe");
    expect(notificationCommand("win32", "a", "b", () => null)).toBeNull();
  });
});

describe("defaultNotificationSender", () => {
  it("runs the platform's command and prints nothing when it works", () => {
    const ran: [string, string[]][] = [];
    const logged: string[] = [];
    const send = defaultNotificationSender(false, {
      platform: "linux",
      find: () => "/usr/bin/notify-send",
      run: (command, args) => { ran.push([command, args]); },
      log: (line) => logged.push(line),
    });
    send("Title", "Text");
    expect(ran).toEqual([["/usr/bin/notify-send", ["--", "Title", "Text"]]]);
    expect(logged).toEqual([]);
  });

  it("prints when the command fails, is missing, or printing was asked for", () => {
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    const fail = () => { throw new Error("no display"); };
    defaultNotificationSender(false, { platform: "win32", find: () => "powershell.exe", run: fail, log })("A", "1");
    defaultNotificationSender(false, { platform: "linux", find: () => null, run: fail, log })("B", "2");
    let ran = false;
    defaultNotificationSender(true, { platform: "darwin", run: () => { ran = true; }, log })("C", "3");
    expect(ran).toBe(false);
    expect(logged).toEqual(["A: 1", "B: 2", "C: 3"]);
  });
});