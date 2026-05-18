const LOGGED_SYMBOL = Symbol("oracle.alreadyLogged");
export function markErrorLogged(error) {
    if (error instanceof Error) {
        error[LOGGED_SYMBOL] = true;
    }
}
export function isErrorLogged(error) {
    return Boolean(error instanceof Error && error[LOGGED_SYMBOL]);
}
