import { renderUnifiedDiff } from "../../src/components/diff-renderer.ts";


const diff = (
	"--- src/app.py:before\n" +
	"+++ src/app.py:after\n" +
	"@@ -24,2 +24,2 @@\n" +
	"-value = \"old\"\n" +
	"+value = \"new\"\n" +
	" context = \"visible\"\n"
);
const lines = [
	"• Edited src/app.py (+1 -1)",
	...renderUnifiedDiff(diff, { width: 100, indent: 4, language: "py" }),
];

process.stdout.write(lines.join("\n"));
