import { UserMessageComponent } from "../../src/components/user-message.ts";

const lines = new UserMessageComponent(
	"这是一个会在较窄终端中换行的用户输入。",
).render(18);

process.stdout.write(lines.join("\n"));
