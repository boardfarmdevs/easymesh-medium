import { MediumModel } from './model.mjs';
const model = new MediumModel();
let options = {};
self.onmessage = event => {
  try {
    if (event.data.patch) model.update(event.data.patch);
    if (event.data.options) options = event.data.options;
    const result = model.explore(options);
    self.postMessage({ revision: event.data.revision, result });
  } catch (error) { self.postMessage({ error: error.message, revision: event.data.revision }); }
};
