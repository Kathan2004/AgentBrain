import { execFileSync } from "node:child_process";
import { snapshot, watchProject, type Snapshot } from "../ui/model.js";
import { findOnPath } from "./platform.js";

export type NotificationSender = (title: string, message: string) => void;

export interface NotificationCommand {
  command: string;
  args: string[];
}

/** What the sender needs from the machine; injectable so tests never notify for real. */
export interface NotifyDeps {
  platform?: NodeJS.Platform;
  /** Absolute path of a command on PATH, or null. */
  find?: (command: string) => string | null;
  /** Runs the command; throws when it fails. */
  run?: (command: string, args: string[]) => void;
  log?: (line: string) => void;
}

const NOTIFY_STATUSES = new Set(["review", "done", "blocked", "failed", "handoff"]);

/** PowerShell's own AppUserModelID: toasts from an unregistered app ID are silently dropped. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** A PowerShell expression for `text` built only from base64 characters, so nothing in it can be parsed as code. */
function psString(text: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}'))`;
}

/** The PowerShell script: a Windows toast when WinRT is available, else a tray balloon tip. */
export function windowsNotificationScript(title: string, message: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$title = ${psString(title)}`,
    `$text = ${psString(message)}`,
    "try {",
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "  $nodes = $xml.GetElementsByTagName('text')",
    "  $nodes.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null",
    "  $nodes.Item(1).AppendChild($xml.CreateTextNode($text)) | Out-Null",
    "  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
    "} catch {",
    "  Add-Type -AssemblyName System.Windows.Forms",
    "  Add-Type -AssemblyName System.Drawing",
    "  $icon = New-Object System.Windows.Forms.NotifyIcon",
    "  $icon.Icon = [System.Drawing.SystemIcons]::Information",
    "  $icon.BalloonTipTitle = $title",
    "  $icon.BalloonTipText = $text",
    "  $icon.Visible = $true",
    "  $icon.ShowBalloonTip(5000)",
    // The balloon disappears with the process, so stay alive while it shows.
    "  Start-Sleep -Seconds 5",
    "  $icon.Dispose()",
    "}",
  ].join("\n");
}

/** The command that shows a desktop notification on `platform`, or null when there is none. */
export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
  find: (command: string) => string | null = (command) => findOnPath(command),
): NotificationCommand | null {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    };
  }
  if (platform === "win32") {
    const powershell = find("powershell") ?? find("pwsh");
    if (!powershell) return null;
    // -EncodedCommand takes UTF-16LE base64, so the script never passes through command-line quoting.
    const encoded = Buffer.from(windowsNotificationScript(title, message), "utf16le").toString("base64");
    return {
      command: powershell,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    };
  }
  const notifySend = find("notify-send");
  // "--" so a title or message starting with "-" is never read as an option.
  return notifySend ? { command: notifySend, args: ["--", title, message] } : null;
}

/** Send a desktop notification, or print it when desktop notifications are unavailable. */
export function defaultNotificationSender(print = false, deps: NotifyDeps = {}): NotificationSender {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? ((command, args) => { execFileSync(command, args, { stdio: "ignore", windowsHide: true }); });
  const log = deps.log ?? console.log;
  return (title, message) => {
    if (!print) {
      const notification = notificationCommand(platform, title, message, deps.find);
      if (notification) {
        try {
          run(notification.command, notification.args);
          return;
        } catch {
          // Fall through to stdout if the notifier is unavailable or fails.
        }
      }
    }
    log(`${title}: ${message}`);
  };
}

function taskKey(task: Snapshot["tasks"][number]): string {
  return `${task.status}\0${task.warning ?? ""}`;
}

/** Watch task state and notify once for each settlement or newly appearing stall warning. */
export function watchNotifications(root: string, send: NotificationSender): () => void {
  const previous = new Map<string, string>();
  let initialized = false;

  const check = () => {
    const current = snapshot(root);
    for (const task of current.tasks) {
      const oldKey = previous.get(task.id);
      const key = taskKey(task);
      if (initialized && oldKey !== undefined) {
        const [oldStatus, oldWarning] = oldKey.split("\0");
        if (oldStatus !== task.status && NOTIFY_STATUSES.has(task.status)) {
          send(`Task ${task.status}: ${task.id}`, task.objective);
        } else if (!oldWarning && task.warning) {
          send(`Task stalled: ${task.id}`, task.warning);
        }
      }
      previous.set(task.id, key);
    }
    initialized = true;
  };

  check();
  return watchProject(root, check);
}