import { dispatchWorkflow } from './dispatch.js';

// Only export the Worker handler; constants/helpers belong in dispatch.js.
// Scheduled events only: no fetch handler, routes, workers.dev or preview URLs.
export default {
  async scheduled(controller, env) {
    await dispatchWorkflow(controller, env);
  }
};
