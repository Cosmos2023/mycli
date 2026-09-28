import type { NetworkAccessDetails } from "./generated/network-access.ts";
import { validateNetworkAccessDetails } from "./generated/validators/contract-validation.ts";

const REASONS: Readonly<Record<NetworkAccessDetails["reason"], string>> = {
	approval_required: "This domain requires approval / 此域名需要逐次授权",
	domain_denied: "Domain is outside the allowed list / 域名不在允许范围内",
	method_denied: "HTTP method is forbidden in limited mode / 受限模式禁止此 HTTP 方法",
	private_address: "Private or reserved address is forbidden / 禁止访问内网或保留地址",
	dns_failed: "Public address lookup failed / 无法解析公网地址",
	approval_denied: "You rejected this request / 你拒绝了此次访问",
	approval_unavailable: "No interactive approval is available / 当前无法交互审批",
	approval_timeout: "Approval wait expired / 等待授权超时",
	request_cancelled: "Request was cancelled / 请求已取消",
	port_denied: "Protocol or port is forbidden / 协议或端口被禁止",
	invalid_request: "Invalid proxy request / 代理请求格式无效",
	capacity_exceeded: "Too many pending requests / 待处理请求过多",
	connection_failed: "Proxy connection failed / 代理连接失败",
};

export function networkAccessReasonText(reason: NetworkAccessDetails["reason"]): string {
	return REASONS[reason];
}

export function networkAccessTargetText(details: NetworkAccessDetails): string {
	return details.host ? `${details.host}${details.port ? `:${details.port}` : ""}${details.protocol ? ` (${details.protocol.toUpperCase()})` : ""}${details.method ? ` ${details.method}` : ""}` : "";
}

export function networkAccessDetailsFromUnknown(value: unknown): NetworkAccessDetails | undefined {
	return validateNetworkAccessDetails(value) ? { ...value as NetworkAccessDetails } : undefined;
}
