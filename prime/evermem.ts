/**
 * EverMem / EverOS Extension for Prime Agent.
 * Bridges Prime lifecycle events to the shared EverMem hook scripts.
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE_BIN = process.execPath;
const PLUGIN_DIR = path.resolve(EXTENSION_DIR, "../hooks/scripts");

function runEvermemScript(scriptName: string, inputPayload: object, abortSignal?: AbortSignal): Promise<any | null> {
  const scriptPath = path.join(PLUGIN_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`EverMem hook script not found: ${scriptPath}`);
  }

  const env = { ...process.env };

  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    let cancelled = false;
    const abortChild = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    if (abortSignal?.aborted) abortChild();
    else abortSignal?.addEventListener("abort", abortChild, { once: true });

    child.on("error", (error) => {
      abortSignal?.removeEventListener("abort", abortChild);
      reject(cancelled
        ? new Error(`EverMem ${scriptName} cancelled with the Prime lifecycle: ${error.message}`)
        : error);
    });
    child.on("close", (code, signal) => {
      abortSignal?.removeEventListener("abort", abortChild);
      if (cancelled) {
        reject(new Error(`EverMem ${scriptName} cancelled with the Prime lifecycle`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `EverMem ${scriptName} exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.trim()}`
        ));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(output));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new Error(`EverMem ${scriptName} returned invalid JSON: ${detail}; stdout=${output}; stderr=${stderr.trim()}`));
      }
    });

    child.stdin.end(JSON.stringify(inputPayload));
  });
}

function notifyResult(ctx: any, result: any) {
  if (result?.systemMessage && ctx.ui?.notify) {
    ctx.ui.notify(result.systemMessage, "info");
  }
}

function getRecallContext(result: any): string {
  return result?.hookSpecificOutput?.additionalContext
    || result?.additionalContext
    || "";
}

export default function (pi: any) {
  let sessionContext = "";

  pi.on("session_start", async (event: any, ctx: any) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
    const payload = {
      session_id: sessionFile,
      source: event.reason,
      cwd: ctx.cwd,
    };

    const result = await runEvermemScript("session-context.js", payload, ctx.signal);
    sessionContext = result?.systemPrompt || "";
    notifyResult(ctx, result);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
    const payload = {
      session_id: sessionFile,
      prompt: event.prompt || "",
      cwd: ctx.cwd,
    };

    const result = await runEvermemScript("inject-memories.js", payload, ctx.signal);
    notifyResult(ctx, result);

    const contexts = [sessionContext, getRecallContext(result)].filter(Boolean);
    if (contexts.length > 0) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${contexts.join("\n\n")}`,
      };
    }
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      throw new Error(`EverMem cannot store turn: Prime session file is unavailable (${sessionFile || "empty path"})`);
    }

    const result = await runEvermemScript("store-memories.js", {
      session_id: sessionFile,
      transcript_path: sessionFile,
      cwd: ctx.cwd,
    }, ctx.signal);
    notifyResult(ctx, result);
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      throw new Error(`EverMem cannot summarize session: Prime session file is unavailable (${sessionFile || "empty path"})`);
    }

    const result = await runEvermemScript("session-summary.js", {
      session_id: sessionFile,
      transcript_path: sessionFile,
      cwd: ctx.cwd,
      reason: event.reason,
    }, ctx.signal);
    notifyResult(ctx, result);
  });
}
