from __future__ import annotations

from mycli.memory.memdir import ENTRYPOINT_NAME

MEMORY_FRONTMATTER_EXAMPLE = (
    "```markdown",
    "---",
    "name: {{memory name}}",
    "description: {{one-line description - used to decide relevance in future conversations, so be specific}}",
    "type: {{user, feedback, project, reference}}",
    "---",
    "",
    "{{memory content - for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
    "```",
)

TYPES_SECTION_INDIVIDUAL = (
    "## Types of memory",
    "",
    "There are several discrete types of memory that you can store in your memory system:",
    "",
    "<types>",
    "<type>",
    "    <name>user</name>",
    "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Avoid writing negative judgements or details that are not relevant to future work.</description>",
    "    <when_to_save>When you learn durable details about the user's role, preferences, responsibilities, or knowledge.</when_to_save>",
    "    <how_to_use>Use when future work should be informed by the user's profile or perspective.</how_to_use>",
    "</type>",
    "<type>",
    "    <name>feedback</name>",
    "    <description>Guidance the user has given about how to approach work - what to avoid and what to keep doing.</description>",
    "    <when_to_save>Any time the user corrects your approach or confirms a non-obvious approach worked. Include why so edge cases can be judged later.</when_to_save>",
    "    <how_to_use>Let these memories guide behavior so the user does not need to repeat the same guidance.</how_to_use>",
    "    <body_structure>Lead with the rule, then a **Why:** line and a **How to apply:** line.</body_structure>",
    "</type>",
    "<type>",
    "    <name>project</name>",
    "    <description>Information about ongoing work, goals, initiatives, bugs, or incidents in this project that is not otherwise derivable from code or git history.</description>",
    "    <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates.</when_to_save>",
    "    <how_to_use>Use to understand motivation, deadlines, coordination issues, and context behind future requests.</how_to_use>",
    "    <body_structure>Lead with the fact or decision, then a **Why:** line and a **How to apply:** line.</body_structure>",
    "</type>",
    "<type>",
    "    <name>reference</name>",
    "    <description>Stores pointers to where information can be found in external systems.</description>",
    "    <when_to_save>When you learn about external resources and their purpose.</when_to_save>",
    "    <how_to_use>Use when the user references that external system or when work may depend on it.</how_to_use>",
    "</type>",
    "</types>",
    "",
)

WHAT_NOT_TO_SAVE_SECTION = (
    "## What NOT to save in memory",
    "",
    "- Code patterns, conventions, architecture, file paths, or project structure - these can be derived by reading the current project state.",
    "- Git history, recent changes, or who-changed-what - git is authoritative.",
    "- Debugging solutions or fix recipes - the fix is in code and commit messages.",
    "- Anything already documented in workspace instruction files.",
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
    "",
    "These exclusions apply even when the user explicitly asks you to save. If they ask you to save an activity summary, ask what was surprising or non-obvious about it - that is the part worth keeping.",
)

SELECT_MEMORIES_SYSTEM_PROMPT = """You are selecting memories that will be useful to mycli as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a `selected_memories` array containing filenames for memories that will clearly be useful as mycli processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it. Be selective.
- If there are no clearly useful memories, return an empty list.
- If recently used tools are provided, do not select memories that are usage reference or API documentation for those tools. Do select warnings, gotchas, or known issues about those tools.
"""


def build_extract_auto_only_prompt(
    *,
    new_message_count: int,
    existing_memories: str,
    memory_dir: str,
) -> str:
    manifest = (
        f"\n\n## Existing memory files\n\n{existing_memories}\n\n"
        "Check this list before writing - update an existing file rather than creating a duplicate."
        if existing_memories
        else ""
    )
    opener = "\n".join(
        [
            f"You are now acting as the memory extraction subagent. Analyze the most recent ~{new_message_count} messages above and use them to update your persistent memory system.",
            "",
            "Available tools: Read, LS, and Edit/Write for paths inside the memory directory only. All other tools will be denied.",
            "",
            "You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 - issue all Read calls in parallel for every file you might update; turn 2 - issue all Write/Edit calls in parallel. Do not interleave reads and writes across many turns.",
            "",
            "You MUST only use content from the latest turn to update persistent memories. Do not investigate or verify that content further - no grepping source files, no reading code to confirm a pattern exists, no git commands.",
            manifest,
        ]
    )
    how_to_save = [
        "## How to save memories",
        "",
        "Saving a memory is a two-step process:",
        "",
        "**Step 1** - write the memory to its own file using this frontmatter format:",
        "",
        *MEMORY_FRONTMATTER_EXAMPLE,
        "",
        f"**Step 2** - add a pointer to that file in `{ENTRYPOINT_NAME}`. `{ENTRYPOINT_NAME}` is an index, not a memory - each entry should be one line, under ~150 characters: `- [Title](file.md) - one-line hook`. It has no frontmatter. Never write memory content directly into `{ENTRYPOINT_NAME}`.",
        "",
        f"- `{ENTRYPOINT_NAME}` is always loaded into conversation context; keep it concise.",
        "- Organize memory semantically by topic, not chronologically.",
        "- Update or remove memories that turn out to be wrong or outdated.",
        "- Do not write duplicate memories. First check if there is an existing memory you can update.",
    ]
    return "\n".join(
        [
            opener,
            "",
            f"Memory directory: {memory_dir}",
            "",
            "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
            "",
            *TYPES_SECTION_INDIVIDUAL,
            *WHAT_NOT_TO_SAVE_SECTION,
            "",
            *how_to_save,
        ]
    )


def build_dream_consolidation_prompt(
    *,
    memory_dir: str,
    existing_memories: str,
    recent_session_ids: tuple[str, ...],
) -> str:
    sessions = "\n".join(f"- {session_id}" for session_id in recent_session_ids)
    manifest = existing_memories or "(no memory files yet)"
    return "\n".join(
        [
            "# Dream: Memory Consolidation",
            "",
            "You are performing a dream - a reflective pass over the persistent memory files. Synthesize what has been learned recently into durable, well-organized memories so future sessions can orient quickly.",
            "",
            f"Memory directory: `{memory_dir}`",
            "The directory exists. Use Read, LS, Edit, and Write inside it. Bash is read-only and may only inspect files.",
            "",
            "## Phase 1 - Orient",
            "",
            f"- Read `{ENTRYPOINT_NAME}` to understand the current index.",
            "- Skim existing topic files so you improve them rather than creating duplicates.",
            "- Existing memory manifest:",
            manifest,
            "",
            "## Phase 2 - Gather recent signal",
            "",
            "Review the session IDs below as hints for recent activity. Use only narrow searches if you need session context. Do not exhaustively read transcripts.",
            f"Sessions since last consolidation ({len(recent_session_ids)}):",
            sessions or "- none",
            "",
            "## Phase 3 - Consolidate",
            "",
            "For each thing worth remembering, write or update a top-level memory file using the standard memory frontmatter. Merge new signal into existing topic files instead of creating near-duplicates.",
            "Convert relative dates to absolute dates. Delete or correct contradicted facts at the source.",
            "",
            *TYPES_SECTION_INDIVIDUAL,
            *WHAT_NOT_TO_SAVE_SECTION,
            "",
            "## Phase 4 - Prune and index",
            "",
            f"Update `{ENTRYPOINT_NAME}` so it stays concise. It is an index, not a dump. Each entry should be one short line: `- [Title](file.md) - one-line hook`.",
            "Remove pointers to stale, wrong, superseded, or deleted memories. If two files disagree, fix the wrong one.",
            "",
            "Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so.",
        ]
    )
