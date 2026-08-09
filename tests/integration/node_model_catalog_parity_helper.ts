import {
	loadModelCatalog,
	modelCatalogEntryPayload,
	type ModelCatalogCurrentConfig,
} from "../../backend/packages/config/src/index.ts";

const [homeDir, currentRaw] = process.argv.slice(2);
if (!homeDir || !currentRaw) throw new Error("usage: helper <home-dir> <current-json>");
const currentConfig = JSON.parse(currentRaw) as ModelCatalogCurrentConfig;
const entries = await loadModelCatalog({ homeDir, currentConfig });
process.stdout.write(`${JSON.stringify(entries.map(modelCatalogEntryPayload))}\n`);
