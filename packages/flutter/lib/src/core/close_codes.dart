/// Only 1008 (policy violation) is terminal: retrying it can never succeed, whatever the reason.
/// Every other code, including an unknown one or none at all, is worth a reconnect inside the
/// grace window. The reason string is never inspected.
bool isTerminalClose(int? code) => code == 1008;
