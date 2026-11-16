import { getAllModels } from "../pricing.js";
import { modelsForProvider, filterCatalogModels } from "../model-catalog.js";

export interface ModelsArgs {
  json: boolean;
  provider?: string;
  includeLegacy?: boolean;
  tier?: "latest";
}

export function runModels(args: ModelsArgs): void {
  const catalogOpts = {
    includeLegacy: args.includeLegacy,
    tier: args.tier,
  };
  let models = args.provider
    ? modelsForProvider(args.provider, catalogOpts)
    : filterCatalogModels([...getAllModels()], catalogOpts);

  if (args.json) {
    process.stdout.write(JSON.stringify(models, null, 2) + "\n");
    return;
  }

  if (models.length === 0) {
    process.stdout.write(
      args.provider
        ? `No models found for provider '${args.provider}'.\n`
        : "No models in catalogue.\n",
    );
    return;
  }

  // Human-readable table — widths sized to the longest model id
  const idWidth = Math.max(...models.map((m) => m.id.length), 8);
  const header = `${"MODEL".padEnd(idWidth)}  ${"INPUT ($/M)".padStart(12)}  ${"OUTPUT ($/M)".padStart(13)}  LAST UPDATED`;
  const sep = "-".repeat(header.length);

  process.stdout.write(header + "\n" + sep + "\n");

  for (const m of models) {
    const last =
      m.last_updated.length >= 10 ? m.last_updated.slice(0, 10) : m.last_updated;
    const row = [
      m.id.padEnd(idWidth),
      `$${m.input_per_million_usd.toFixed(2)}`.padStart(12),
      `$${m.output_per_million_usd.toFixed(2)}`.padStart(13),
      last,
    ].join("  ");
    process.stdout.write(row + "\n");
  }
}
