'use strict';
// Pick Electron's --ozone-platform. A stalled Wayland client is dropped by the compositor
// ("Fatal Wayland communication error: Broken pipe", exit 0, no dump); X11/XWayland isn't.
// SM_OZONE_PLATFORM=x11|wayland wins; auto/unset -> x11 on a Wayland session with DISPLAY.
// null = leave Electron's default alone.
function chooseOzonePlatform(env = {}) {
  const override = String(env.SM_OZONE_PLATFORM || '').trim().toLowerCase();
  if (override === 'x11' || override === 'wayland') return override;
  const session = String(env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  const display = String(env.DISPLAY || '').trim();
  if (session === 'wayland' && display) return 'x11';
  return null;
}

module.exports = { chooseOzonePlatform };
