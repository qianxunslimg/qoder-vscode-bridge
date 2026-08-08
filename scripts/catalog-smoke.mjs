import { fetchModelCatalog } from '../out/modelCatalogService.js';

const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim();
if (!pat) {
  console.error('QODER_PERSONAL_ACCESS_TOKEN is required');
  process.exit(2);
}

const models = await fetchModelCatalog(pat, process.cwd());
const enabled = models.filter((model) => model.isEnabled !== false);
const expected = ['qmodel_38max', 'dmodel', 'kmodel'];
const missing = expected.filter(
  (id) => !enabled.some((model) => model.value === id),
);
if (missing.length > 0) {
  throw new Error(`catalog is missing expected model ids: ${missing.join(', ')}`);
}

const output = enabled.map((model) => ({
  id: model.value,
  name: model.displayName,
  maxContextWindow: model.availableContextWindows?.length
    ? Math.max(...model.availableContextWindows)
    : undefined,
  defaultContextWindow: model.defaultContextWindow,
}));
console.log(JSON.stringify({ marker: 'QODER_CATALOG_OK', models: output }));
