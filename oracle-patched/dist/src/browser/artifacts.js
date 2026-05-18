import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
const ARTIFACTS_DIRNAME = "artifacts";
function sanitizePathSegment(value, fallback) {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
    return sanitized || fallback;
}
function normalizeSessionId(sessionId) {
    return sanitizePathSegment(path.basename(sessionId), "session");
}
export function resolveSessionArtifactsDir(sessionId) {
    return path.join(getOracleHomeDir(), "sessions", normalizeSessionId(sessionId), ARTIFACTS_DIRNAME);
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveUniquePath(basePath) {
    const ext = path.extname(basePath);
    const stem = ext ? path.basename(basePath, ext) : path.basename(basePath);
    const dir = path.dirname(basePath);
    let candidate = basePath;
    let suffix = 2;
    while (await pathExists(candidate)) {
        candidate = path.join(dir, `${stem}-${suffix}${ext}`);
        suffix += 1;
    }
    return candidate;
}
async function readSizeBytes(targetPath) {
    try {
        return (await fs.stat(targetPath)).size;
    }
    catch {
        return undefined;
    }
}
export async function writeTextBrowserArtifact(params) {
    const text = params.contents.trim();
    if (!params.sessionId || text.length === 0) {
        return null;
    }
    const dir = resolveSessionArtifactsDir(params.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filename = sanitizePathSegment(params.filename, "artifact.md");
    const targetPath = await resolveUniquePath(path.join(dir, filename));
    await fs.writeFile(targetPath, `${text}\n`, "utf8");
    params.logger?.(`[browser] Saved ${params.kind} artifact to ${targetPath}`);
    return {
        kind: params.kind,
        path: targetPath,
        label: params.label,
        mimeType: params.mimeType ?? "text/markdown",
        sizeBytes: await readSizeBytes(targetPath),
        sourceUrl: params.sourceUrl,
    };
}
function isToolOnlyPlaceholder(text) {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return (normalized === "called tool" ||
        normalized === "used tool" ||
        normalized === "użyto narzędzia" ||
        normalized === "narzędzie wywołane");
}
export async function saveDeepResearchReportArtifact(params) {
    const report = params.reportMarkdown.trim();
    if (report.length < 40 || isToolOnlyPlaceholder(report)) {
        return null;
    }
    return writeTextBrowserArtifact({
        sessionId: params.sessionId,
        kind: "deep-research-report",
        filename: "deep-research-report.md",
        contents: report,
        label: "Deep Research report",
        mimeType: "text/markdown",
        sourceUrl: params.conversationUrl,
        logger: params.logger,
    });
}
export async function saveBrowserTranscriptArtifact(params) {
    const answer = params.answerMarkdown.trim();
    if (!answer) {
        return null;
    }
    const artifactLines = params.artifacts && params.artifacts.length > 0
        ? [
            "",
            "## Artifacts",
            "",
            ...params.artifacts.map((artifact) => {
                const label = artifact.label ?? artifact.kind;
                return `- ${label}: ${artifact.path}`;
            }),
        ]
        : [];
    const conversationLines = params.conversationUrl
        ? ["", `Conversation: ${params.conversationUrl}`, ""]
        : ["", ""];
    const body = [
        "# Oracle Browser Transcript",
        ...conversationLines,
        "## Prompt",
        "",
        params.prompt.trim(),
        "",
        "## Answer",
        "",
        answer,
        ...artifactLines,
    ].join("\n");
    return writeTextBrowserArtifact({
        sessionId: params.sessionId,
        kind: "transcript",
        filename: "transcript.md",
        contents: body,
        label: "Browser transcript",
        mimeType: "text/markdown",
        sourceUrl: params.conversationUrl,
        logger: params.logger,
    });
}
export function appendArtifacts(existing, additions) {
    const merged = new Map();
    for (const artifact of existing ?? []) {
        merged.set(`${artifact.kind}:${artifact.path}`, artifact);
    }
    for (const artifact of additions) {
        if (artifact) {
            merged.set(`${artifact.kind}:${artifact.path}`, artifact);
        }
    }
    const values = Array.from(merged.values());
    return values.length > 0 ? values : undefined;
}
export const __test__ = {
    normalizeSessionId,
    sanitizePathSegment,
};
