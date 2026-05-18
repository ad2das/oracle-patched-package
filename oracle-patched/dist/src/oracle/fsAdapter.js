export function createFsAdapter(fsModule) {
    const adapter = {
        stat: (targetPath) => fsModule.stat(targetPath),
        readdir: (targetPath) => fsModule.readdir(targetPath),
        readFile: (targetPath, encoding) => fsModule.readFile(targetPath, encoding),
    };
    // Mark adapters so downstream callers can treat them as native filesystem access.
    adapter.__nativeFs = true;
    return adapter;
}
