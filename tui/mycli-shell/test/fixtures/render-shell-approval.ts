import { ApprovalSelectorComponent } from "../../src/components/selectors/approval-selector.ts";
import { setUiGlyphMode } from "../../src/theme/terminal-style.ts";
import { theme } from "../../src/theme/theme.ts";

const width = Number(process.argv[2] ?? 80);
theme.setName(process.argv[3] === "light" ? "light" : "dark");
setUiGlyphMode(process.env.TERM === "dumb" ? "ascii" : "unicode");

const selector = new ApprovalSelectorComponent({
	approval: {
		decisionId: "shell-approval-preview",
		toolName: "Shell",
		preview: "Shell command requires approval",
		commandPreview: "npm run build --workspace @mycli/runtime &&\n  npm test -- --test-name-pattern='approval|shell'",
		reason: "This command requests broader permissions than currently allowed.",
		justification: "Run the build and approval regression tests.",
		risk: "medium",
		riskReason: "Runs workspace scripts with broader permissions",
		persistentRulePreview: '["npm", "run", "build"]',
		options: [
			{ choice: "approve_once", label: "Allow once" },
			{ choice: "reject", label: "Reject" },
			{ choice: "allow_session", label: "Allow for this session" },
			{ choice: "always_allow", label: "Always allow" },
		],
	},
	onSelect: () => undefined,
	onCancel: () => undefined,
	maxHeight: () => 24,
});

process.stdout.write(selector.render(width).join("\n"));
