import path from "node:path";
export const PROJECT_SOURCES_MAX_UPLOAD_BATCH = 10;
export function buildProjectSourcesUploadPlan(files) {
    return files.map((file, index) => ({
        path: file.path,
        displayPath: file.displayPath,
        name: path.basename(file.path),
        sizeBytes: file.sizeBytes,
        batch: Math.floor(index / PROJECT_SOURCES_MAX_UPLOAD_BATCH) + 1,
    }));
}
export function diffAddedProjectSources(before, after) {
    const remainingBefore = new Map();
    for (const source of before) {
        remainingBefore.set(source.name, (remainingBefore.get(source.name) ?? 0) + 1);
    }
    const added = [];
    for (const source of after) {
        const count = remainingBefore.get(source.name) ?? 0;
        if (count > 0) {
            remainingBefore.set(source.name, count - 1);
            continue;
        }
        added.push(source);
    }
    return added;
}
