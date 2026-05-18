import chalk from "chalk";
import { DEFAULT_MODEL } from "../oracle/config.js";
import { resolveApiModel } from "./options.js";
import { loadUserConfig } from "../config.js";
import { buildProviderRoutePlan } from "../oracle/providerRoutePlan.js";
export async function runProviderDoctor(options) {
    if (!options.providers) {
        console.log("Run `oracle doctor --providers` to inspect API provider readiness.");
        return;
    }
    const { config: userConfig } = await loadUserConfig();
    const providerMode = resolveProviderMode(options);
    const azure = resolveAzureOptions(options, userConfig);
    const models = resolveModels(options, userConfig);
    const plans = models.map((model) => buildProviderRoutePlan({
        model,
        providerMode,
        azure,
        baseUrl: options.baseUrl ?? userConfig.apiBaseUrl,
        env: process.env,
    }));
    if (options.json) {
        console.log(JSON.stringify({ providers: plans }, null, 2));
        process.exitCode = plans.some((plan) => !plan.ok) ? 1 : 0;
        return;
    }
    printProviderPlans(plans);
    process.exitCode = plans.some((plan) => !plan.ok) ? 1 : 0;
}
export function printProviderPlans(plans, { title = "Provider readiness" } = {}) {
    console.log(chalk.bold(title));
    console.log("");
    for (const plan of plans) {
        const status = plan.ok ? chalk.green("ok") : chalk.red("not ready");
        console.log(`${plan.model}: ${status}`);
        console.log(chalk.dim(`  provider: ${plan.providerLabel}`));
        console.log(chalk.dim(`  base: ${plan.base || "(none)"}`));
        console.log(chalk.dim(`  key: ${plan.keyPreview}`));
        if (plan.isAzureOpenAI || plan.azureDeploymentName) {
            console.log(chalk.dim(`  azure deployment: ${plan.azureDeploymentName ?? "none"}`));
        }
        if (plan.azureNote) {
            console.log(chalk.dim(`  azure: ${plan.azureNote}`));
        }
        if (plan.error) {
            console.log(chalk.dim(`  error: ${plan.error}`));
        }
        console.log("");
    }
}
function resolveModels(options, userConfig) {
    const entries = Array.isArray(options.models) && options.models.length > 0
        ? options.models
        : typeof options.models === "string" && options.models.trim().length > 0
            ? options.models
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            : [options.model ?? userConfig.model ?? DEFAULT_MODEL];
    return Array.from(new Set(entries.map((entry) => resolveApiModel(entry))));
}
function resolveProviderMode(options) {
    const provider = options.provider ?? "auto";
    if (provider === "azure" && options.azure === false) {
        throw new Error("--provider azure cannot be combined with --no-azure.");
    }
    if (options.azure === false) {
        return "openai";
    }
    return provider;
}
function resolveAzureOptions(options, userConfig) {
    const endpoint = firstNonEmpty(options.azureEndpoint, process.env.AZURE_OPENAI_ENDPOINT, userConfig.azure?.endpoint);
    if (!endpoint) {
        return undefined;
    }
    return {
        endpoint,
        deployment: firstNonEmpty(options.azureDeployment, process.env.AZURE_OPENAI_DEPLOYMENT, userConfig.azure?.deployment),
        apiVersion: firstNonEmpty(options.azureApiVersion, process.env.AZURE_OPENAI_API_VERSION, userConfig.azure?.apiVersion),
    };
}
function firstNonEmpty(...values) {
    return values.find((value) => value?.trim());
}
