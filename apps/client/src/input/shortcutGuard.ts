/**
 * Keeping browser shortcuts from ending a match. Browsers don't let a normal page block
 * Ctrl+W / Ctrl+T / Ctrl+N (close tab, new tab, new window). Two things a page can do:
 *
 * 1. Fullscreen + Keyboard Lock (Chrome, Edge): in fullscreen, a page may lock the keyboard
 *    so those shortcuts reach the game instead of the browser. Holding Esc still exits
 *    fullscreen (the browser guarantees that), which also releases the lock.
 * 2. A leave guard (every browser): while in a match, closing or leaving the page asks
 *    "Leave site?" first instead of closing straight away.
 */

interface KeyboardLock {
  lock?: (keys?: string[]) => Promise<void>;
}

/** Fullscreen with the keyboard locked. Must run inside a click (a user gesture). */
export async function enterGameFullscreen(): Promise<void> {
  if (automatedWithout('fullscreen')) return; // test browsers keep their window as it is
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    // Every key, so browser shortcuts come to the game while fullscreen.
    await (navigator as unknown as { keyboard?: KeyboardLock }).keyboard?.lock?.();
  } catch {
    // Not allowed here (iframe policy, browser setting, no gesture): the leave guard remains.
  }
}

let guardOn = false;
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!guardOn) return;
  e.preventDefault();
  e.returnValue = ''; // older browsers need a value to show the dialog
};
window.addEventListener('beforeunload', onBeforeUnload);

/**
 * In a match: ask before the page closes or navigates away. Off before an intentional leave.
 * Automated browsers skip it (it would block their own page changes) unless the URL asks
 * for it with ?leaveguard (tests of the guard itself).
 */
export function setLeaveGuard(on: boolean): void {
  guardOn = on && !automatedWithout('leaveguard');
}

/** An automated (test) browser, unless the URL opts in to this feature with ?<flag>. */
function automatedWithout(flag: string): boolean {
  return navigator.webdriver && !new URLSearchParams(location.search).has(flag);
}
