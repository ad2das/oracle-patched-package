import { defaultBrowserThinkingTimeForModel, mapModelToBrowserLabel } from "../oracle-patched/dist/src/cli/browserConfig.js";
import { inferModelFromLabel } from "../oracle-patched/dist/src/cli/options.js";
import { ensureModelSelection } from "../oracle-patched/dist/src/browser/actions/modelSelection.js";
import { ensureThinkingTime } from "../oracle-patched/dist/src/browser/actions/thinkingTime.js";

export async function verifyRecoveryModel(Runtime, meta, logger) {
  const config = meta.browser?.config ?? meta.options?.browserConfig ?? {};
  const requestedModel = meta.options?.model ?? meta.model ?? config.desiredModel;
  if (!requestedModel) return;
  const model = inferModelFromLabel(requestedModel);
  const requiredLevel = defaultBrowserThinkingTimeForModel(model);
  const isGpt6 = model.startsWith("gpt-6-");
  if (!isGpt6 && requiredLevel !== "pro" && config.thinkingTime !== "pro") return;
  const desiredModel = mapModelToBrowserLabel(model);
  await ensureModelSelection(Runtime, desiredModel, logger, "select");
  const thinkingTime = requiredLevel ?? config.thinkingTime;
  if (thinkingTime) await ensureThinkingTime(Runtime, thinkingTime, logger, desiredModel);
}
