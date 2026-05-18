import { isProModel } from "../oracle/modelResolver.js";
export function shouldDetachSession({ 
// Params kept for policy tweaks.
engine, model, waitPreference, disableDetachEnv, }) {
    if (disableDetachEnv)
        return false;
    // Explicit --wait means "stay attached", regardless of model defaults.
    if (waitPreference)
        return false;
    // Only Pro-tier API runs should start detached by default; browser runs stay inline so failures surface.
    if (isProModel(model) && engine === "api")
        return true;
    return false;
}
