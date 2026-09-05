// Disabled: ask_question runs in the app runtime and parks the turn on a
// human reply ("Ask the user a clarifying question or a choice mid-turn
// and park until they answer." — docs/concepts/built-in-tools.md). This
// agent runs unattended against a fixed task/submit loop with a 10-minute
// session timeout; there is no user on the other end to answer, so the
// only effect of exposing this tool would be a stalled, wasted session.

import { disableTool } from "eve/tools";

export default disableTool();
