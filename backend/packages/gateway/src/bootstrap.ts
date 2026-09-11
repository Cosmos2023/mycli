import type { GatewayParams, GatewayResult } from "@mycli/contracts";
import { GatewayRequestError } from "./client.ts";

export async function bootstrapGateway(
	send: (params: GatewayParams<"session.bootstrap">) => Promise<GatewayResult<"session.bootstrap">>,
): Promise<GatewayResult<"session.bootstrap">> {
	try {
		return await send({ protocol_version: 1, supported_error_context_versions: [1] });
	} catch (error) {
		if (!(error instanceof GatewayRequestError) || error.code !== "invalid_params"
			|| (error.data.parameter !== "supported_error_context_versions"
				&& error.message !== "Invalid gateway params for session.bootstrap.")) throw error;
		return await send({ protocol_version: 1 });
	}
}
