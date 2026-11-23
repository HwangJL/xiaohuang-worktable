/**
 * PM Copilot — Client half, part 99: loader tail.
 *
 * Closes the lazy factory opened in `00-head.js` and publishes the plugin
 * module: the required Cordis services plus `apply`. Every earlier part has run
 * by the time this line executes, so `PM.pages` and the page components exist.
 */

    return { inject, apply }
  },
})
