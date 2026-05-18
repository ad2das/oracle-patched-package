export async function readStdin(stream = process.stdin) {
    const chunks = [];
    const maybeTextStream = stream;
    maybeTextStream.setEncoding?.("utf8");
    for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    }
    return chunks.join("");
}
export async function resolveDashPrompt(prompt, stream = process.stdin) {
    if (prompt !== "-") {
        return prompt;
    }
    if (stream.isTTY) {
        throw new Error(`"-p -" requires piped input, for example: echo "prompt" | oracle -p -.`);
    }
    const stdinPrompt = (await readStdin(stream)).trim();
    if (!stdinPrompt) {
        throw new Error(`"-p -" received empty stdin.`);
    }
    return stdinPrompt;
}
