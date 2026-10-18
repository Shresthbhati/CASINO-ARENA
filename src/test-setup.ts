// jsdom does not implement scrolling and logs "Not implemented" on every call. The app scrolls to the top
// when the screen changes, so give the tests a no-op rather than a wall of noise. Node-environment tests have no window.
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined;
}
