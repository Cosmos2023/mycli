import { readFileSync } from "node:fs";
import { parseGatewayContractCatalog } from "./validation.ts";

const catalogUrl = new URL("../schemas/catalog.json", import.meta.url);

export const gatewayContractCatalog = parseGatewayContractCatalog(
	JSON.parse(readFileSync(catalogUrl, "utf8")) as unknown,
);
