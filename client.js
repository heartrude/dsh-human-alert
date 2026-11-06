/**
 * Client half of dsh-human-alert.
 *
 * Subscribes to the Host focus bridge over same-origin SSE and switches the
 * GUI to the alerting Session when its notification banner is clicked.
 * No UI of its own; this module only performs one navigation action.
 */
window.__ModuleLoader__.load({
  id: 'dsh-human-alert',
  factory() {
    return {
      apply(ctx) {
        let closed = false;
        let es;
        const connect = () => {
          if (closed) return;
          const url = `${window.location.origin}/dsh-human-alert/events`;
          try {
            es = new EventSource(url);
          } catch (err) {
            console.warn('[dsh-human-alert] EventSource init failed', err);
            return;
          }
          es.onopen = () => {
            console.info('[dsh-human-alert] focus bridge connected');
          };
          es.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg && typeof msg.sessionId === 'string' && msg.sessionId) {
                const ui = ctx.get('uiWorkspace');
                if (ui && typeof ui.openSession === 'function') {
                  console.info('[dsh-human-alert] openSession', msg.sessionId);
                  ui.openSession(msg.sessionId);
                } else {
                  console.warn('[dsh-human-alert] uiWorkspace.openSession unavailable');
                }
              }
            } catch (err) {
              console.warn('[dsh-human-alert] bad frame', err);
            }
          };
          es.onerror = () => {
            /* EventSource reconnects automatically */
          };
        };
        connect();
        return () => {
          closed = true;
          es?.close();
        };
      },
    };
  },
});
