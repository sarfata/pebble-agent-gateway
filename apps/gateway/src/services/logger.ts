type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, string | number | boolean | null | undefined>;

function writeLog(level: LogLevel, event: string, fields: LogFields): void {
  const payload: Record<string, string | number | boolean | null> = {
    level,
    event,
    at: new Date().toISOString()
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  writeLog("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  writeLog("error", event, fields);
}
