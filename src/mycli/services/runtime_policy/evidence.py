from __future__ import annotations

from collections.abc import Iterator

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import RuntimeBlock


class RuntimePolicyEvidence:
    def has_sufficient_overview_evidence(self, conversation: Conversation) -> bool:
        tool_names: set[str] = set()
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                tool_name = block.metadata.get("tool_name")
                if isinstance(tool_name, str) and block.metadata.get("success") is True:
                    tool_names.add(tool_name)
        return "list_directory" in tool_names and bool(
            {"read_file", "read_file_range", "search_text"} & tool_names
        )

    def has_sufficient_repo_analysis_evidence(self, conversation: Conversation) -> bool:
        return self.has_structure_evidence(conversation) and self.has_source_or_config_evidence(
            conversation
        )

    def has_sufficient_implementation_audit_evidence(
        self,
        conversation: Conversation,
    ) -> bool:
        source_paths: set[str] = set()
        tool_names: set[str] = set()
        for block in self.iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if isinstance(tool_name, str):
                tool_names.add(tool_name)
            if (
                isinstance(tool_name, str)
                and tool_name in {"read_file", "read_file_range"}
                and isinstance(path, str)
                and self.is_source_or_config_path(path.lower())
            ):
                source_paths.add(path.lower())
        return bool(source_paths) and (len(source_paths) >= 2 or "search_text" in tool_names)

    def has_sufficient_debugging_evidence(self, conversation: Conversation) -> bool:
        has_failure = False
        has_source = False
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is False:
                    has_failure = True
                path = block.metadata.get("path")
                if (
                    block.metadata.get("success") is True
                    and isinstance(path, str)
                    and self.is_source_or_config_path(path.lower())
                    and block.metadata.get("tool_name") in {"read_file", "read_file_range"}
                ):
                    has_source = True
        return has_failure and has_source

    def has_structure_evidence(self, conversation: Conversation) -> bool:
        for block in self.iter_successful_tool_result_blocks(conversation):
            if block.metadata.get("tool_name") == "list_directory":
                return True
        return False

    def has_source_or_config_evidence(self, conversation: Conversation) -> bool:
        for block in self.iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if not isinstance(path, str) or not path:
                continue
            normalized_path = path.lower()
            if normalized_path.endswith("readme.md"):
                continue
            if tool_name in {"read_file", "read_file_range"} and self.is_source_or_config_path(
                normalized_path
            ):
                return True
        return False

    def has_repeated_document_exploration(self, conversation: Conversation) -> bool:
        document_reads: dict[str, int] = {}
        for block in self.iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if tool_name not in {"read_file", "read_file_range"}:
                continue
            if not isinstance(path, str) or not path:
                continue
            normalized_path = path.lower()
            if not self.is_documentation_path(normalized_path):
                continue
            document_reads[normalized_path] = document_reads.get(normalized_path, 0) + 1
            if document_reads[normalized_path] >= 2:
                return True
        return False

    def has_truncation_signal(self, conversation: Conversation) -> bool:
        for block in self.iter_successful_tool_result_blocks(conversation):
            if block.metadata.get("tool_name") not in {"read_file", "read_file_range"}:
                continue
            lowered = (block.text or "").lower()
            if "excerpt truncated" in lowered or "use read_file_range" in lowered:
                return True
        return False

    def iter_successful_tool_result_blocks(
        self,
        conversation: Conversation,
    ) -> Iterator[RuntimeBlock]:
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is not True:
                    continue
                yield block

    def is_documentation_path(self, normalized_path: str) -> bool:
        return normalized_path.endswith("readme.md") or normalized_path.startswith("docs/")

    def is_source_or_config_path(self, normalized_path: str) -> bool:
        return normalized_path.endswith(
            (
                ".py",
                ".toml",
                ".yaml",
                ".yml",
                ".json",
                ".ini",
                ".cfg",
                ".mdx",
                ".rs",
                ".ts",
                ".tsx",
                ".js",
            )
        )
