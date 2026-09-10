import { pathToFileURL } from "node:url";
import { installStandaloneGatewayLifecycle } from "./application/gateway-session.ts";

export { gatewayStartup, gatewayShutdown } from "./application/gateway-session.ts";

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	installStandaloneGatewayLifecycle();
}
