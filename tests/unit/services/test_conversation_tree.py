from mycli.domain.conversation import Conversation, Message
from mycli.services.conversation_tree import ConversationTree


def test_conversation_tree_forks_at_message_index() -> None:
    source = Conversation(
        session_id="root",
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="three"),
        ],
    )
    tree = ConversationTree((source,))

    forked = tree.fork("root", "branch", fork_point=2)

    assert forked.session_id == "branch"
    assert forked.parent_id == "root"
    assert forked.fork_point == 2
    assert [message.content for message in forked.messages] == ["one", "two"]
    assert [branch.session_id for branch in tree.branches()] == ["root", "branch"]


def test_conversation_tree_rewind_keeps_branch_identity() -> None:
    conversation = Conversation(
        session_id="branch",
        parent_id="root",
        fork_point=2,
        messages=[
            Message(role="user", content="one"),
            Message(role="assistant", content="two"),
            Message(role="user", content="branch-only"),
        ],
    )
    tree = ConversationTree((conversation,))

    rewound = tree.rewind("branch", 1)

    assert rewound.session_id == "branch"
    assert rewound.parent_id == "root"
    assert rewound.fork_point == 1
    assert [message.content for message in rewound.messages] == ["one"]


def test_conversation_tree_resume_returns_copy() -> None:
    source = Conversation(
        session_id="demo",
        messages=[Message(role="user", content="hello")],
    )
    tree = ConversationTree((source,))

    resumed = tree.resume("demo")
    resumed.append(Message(role="assistant", content="local edit"))

    assert [message.content for message in source.messages] == ["hello"]
    assert [message.content for message in resumed.messages] == ["hello", "local edit"]


def test_conversation_tree_path_to_root_detects_lineage() -> None:
    root = Conversation(session_id="root")
    child = Conversation(session_id="child", parent_id="root", fork_point=0)
    grandchild = Conversation(session_id="grandchild", parent_id="child", fork_point=0)

    path = ConversationTree((grandchild, root, child)).path_to_root("grandchild")

    assert [conversation.session_id for conversation in path] == ["root", "child", "grandchild"]
