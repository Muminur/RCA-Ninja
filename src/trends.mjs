import { loadManifest } from './manifest.mjs';

/**
 * Compute trend statistics from the RCA manifest.
 *
 * @param {{ outputDir: string }} options
 * @returns {Promise<{
 *   total: number,
 *   tag_counts: Object,
 *   file_counts: Object,
 *   component_counts: Object,
 *   recurrent_files: Array<{ file: string, count: number }>
 * }>}
 */
export async function computeTrends({ outputDir }) {
  const entries = loadManifest(outputDir);

  if (entries.length === 0) {
    return {
      total: 0,
      tag_counts: {},
      file_counts: {},
      component_counts: {},
      recurrent_files: [],
    };
  }

  const tagMap = new Map();
  const fileMap = new Map();
  const componentMap = new Map();

  for (const entry of entries) {
    for (const tag of entry.tags || []) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }
    for (const file of entry.files || []) {
      fileMap.set(file, (fileMap.get(file) || 0) + 1);
    }
    for (const component of entry.components || []) {
      componentMap.set(component, (componentMap.get(component) || 0) + 1);
    }
  }

  const sortDesc = (map) => {
    const sorted = Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
    return sorted;
  };

  const tag_counts = sortDesc(tagMap);
  const file_counts = sortDesc(fileMap);
  const component_counts = sortDesc(componentMap);

  const recurrent_files = [...fileMap.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([file, count]) => ({ file, count }));

  return {
    total: entries.length,
    tag_counts,
    file_counts,
    component_counts,
    recurrent_files,
  };
}
