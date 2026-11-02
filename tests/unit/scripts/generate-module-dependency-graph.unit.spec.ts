import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FILENAMES,
  buildModuleLayerGraph,
  compareArtifactDirectories,
  createCheckedGraphArtifacts,
  type DependencyCruiserReport,
  formatDot,
  formatMarkdown,
  formatMermaid,
  getDependencyStyle,
  groupModulePath,
} from '../../../scripts/generate-module-dependency-graph';

describe('module dependency graph path grouping', () => {
  it('groups module internals by layer and public gate files as public', () => {
    expect(groupModulePath('src/modules/design/domain/design.ts')).toEqual({
      id: 'design/domain',
      layerName: 'domain',
      moduleName: 'design',
    });
    expect(
      groupModulePath('src/modules/auth/infrastructure/drizzle/schema.ts')
    ).toEqual({
      id: 'auth/infrastructure',
      layerName: 'infrastructure',
      moduleName: 'auth',
    });
    expect(groupModulePath('src/modules/user/presentation.ts')).toEqual({
      id: 'user/public',
      layerName: 'public',
      moduleName: 'user',
    });
    expect(groupModulePath('src/platform/components/button.tsx')).toBe(
      undefined
    );
  });
});

describe('module dependency graph edge styles', () => {
  it('classifies dependency-cruiser dependency types into graph styles', () => {
    expect(getDependencyStyle({ dependencyTypes: ['local', 'import'] })).toBe(
      'solid'
    );
    expect(
      getDependencyStyle({ dependencyTypes: ['local', 'dynamic-import'] })
    ).toBe('dashed');
    expect(
      getDependencyStyle({ dependencyTypes: ['type-only', 'import'] })
    ).toBe('dashed');
    expect(getDependencyStyle({ dependencyTypes: ['local', 'export'] })).toBe(
      'dotted'
    );
  });
});

describe('module dependency graph builder', () => {
  it('deduplicates file dependencies into sorted layer edges and hides self edges', () => {
    const report: DependencyCruiserReport = {
      modules: [
        {
          dependencies: [
            {
              dependencyTypes: ['local', 'import'],
              resolved: 'src/modules/design/domain/design.ts',
            },
            {
              dependencyTypes: ['local', 'import'],
              resolved: 'src/modules/design/domain/design-policy.ts',
            },
            {
              dependencyTypes: ['local', 'dynamic-import'],
              resolved: 'src/modules/auth/client.ts',
            },
            {
              dependencyTypes: ['local', 'import'],
              resolved: 'src/modules/design/presentation/design-cover.tsx',
            },
          ],
          source: 'src/modules/design/presentation/page-design.tsx',
        },
        {
          dependencies: [
            {
              dependencyTypes: ['local', 'export'],
              resolved: 'src/modules/design/domain/design.ts',
            },
          ],
          source: 'src/modules/design/index.ts',
        },
        {
          dependencies: [
            {
              dependencyTypes: ['local', 'export'],
              resolved: 'src/modules/kernel/domain/errors/app-error.ts',
            },
            {
              dependencyTypes: ['local', 'import'],
              resolved: 'src/modules/kernel/domain/ids.ts',
            },
          ],
          source: 'src/modules/auth/application/use-cases/get-session.ts',
        },
      ],
    };

    expect(buildModuleLayerGraph(report)).toEqual({
      edges: [
        {
          from: 'auth/application',
          style: 'solid',
          to: 'kernel/domain',
        },
        {
          from: 'design/presentation',
          style: 'dashed',
          to: 'auth/public',
        },
        {
          from: 'design/presentation',
          style: 'solid',
          to: 'design/domain',
        },
        {
          from: 'design/public',
          style: 'dotted',
          to: 'design/domain',
        },
      ],
      nodes: [
        {
          id: 'auth/public',
          layerName: 'public',
          moduleName: 'auth',
        },
        {
          id: 'auth/application',
          layerName: 'application',
          moduleName: 'auth',
        },
        {
          id: 'design/public',
          layerName: 'public',
          moduleName: 'design',
        },
        {
          id: 'design/domain',
          layerName: 'domain',
          moduleName: 'design',
        },
        {
          id: 'design/presentation',
          layerName: 'presentation',
          moduleName: 'design',
        },
        {
          id: 'kernel/domain',
          layerName: 'domain',
          moduleName: 'kernel',
        },
      ],
    });
  });

  it('formats Mermaid and DOT with graph style metadata', () => {
    const graph = buildModuleLayerGraph({
      modules: [
        {
          dependencies: [
            {
              dependencyTypes: ['local', 'dynamic-import'],
              resolved: 'src/modules/auth/client.ts',
            },
            {
              dependencyTypes: ['local', 'export'],
              resolved: 'src/modules/moodboard/index.ts',
            },
          ],
          source: 'src/modules/design/presentation/page-design.tsx',
        },
      ],
    });

    expect(formatMermaid(graph)).toContain(
      'node_design_presentation --> node_auth_public'
    );
    expect(formatMermaid(graph)).toContain('linkStyle 0 stroke-dasharray: 6 4');
    expect(formatMermaid(graph)).toContain('linkStyle 1 stroke-dasharray: 1 4');
    expect(formatDot(graph)).toContain(
      '"design/presentation" -> "auth/public" [style="dashed"]'
    );
    expect(formatDot(graph)).toContain(
      '"design/presentation" -> "moodboard/public" [style="dotted"]'
    );
  });

  it('documents dashed edges as dynamic imports or type-only dependencies', () => {
    expect(formatMarkdown('graph TD\n')).toContain(
      '- Dashed edges are dynamic imports or type-only dependencies.'
    );
    expect(formatMarkdown('graph TD\n')).not.toContain('type-only-only');
  });
});

describe('module dependency graph artifact checks', () => {
  it('creates only the DOT artifact for check mode', () => {
    const artifacts = createCheckedGraphArtifacts({
      modules: [
        {
          dependencies: [],
          source: 'src/modules/design/index.ts',
        },
      ],
    });

    expect(Object.keys(artifacts)).toEqual([ARTIFACT_FILENAMES.dot]);
    expect(artifacts[ARTIFACT_FILENAMES.dot]).toContain(
      'digraph ModuleLayerDependencies'
    );
  });

  it('normalizes line endings before comparing only the DOT artifact by default', () => {
    const actualDir = mkdtempSync(
      path.join(os.tmpdir(), 'module-graph-actual-')
    );
    const expectedDir = mkdtempSync(
      path.join(os.tmpdir(), 'module-graph-expected-')
    );

    try {
      writeFileSync(
        path.join(actualDir, ARTIFACT_FILENAMES.dot),
        'line 1\r\nline 2\r\n'
      );
      writeFileSync(
        path.join(expectedDir, ARTIFACT_FILENAMES.dot),
        'line 1\nline 2\n'
      );
      writeFileSync(
        path.join(actualDir, ARTIFACT_FILENAMES.markdown),
        'old markdown\n'
      );
      writeFileSync(
        path.join(expectedDir, ARTIFACT_FILENAMES.markdown),
        'changed markdown\n'
      );
      writeFileSync(path.join(actualDir, ARTIFACT_FILENAMES.svg), 'old svg\n');
      writeFileSync(
        path.join(expectedDir, ARTIFACT_FILENAMES.svg),
        'changed svg\n'
      );

      expect(compareArtifactDirectories({ actualDir, expectedDir })).toEqual(
        []
      );

      writeFileSync(
        path.join(expectedDir, ARTIFACT_FILENAMES.dot),
        'line 1\nchanged\n'
      );

      expect(compareArtifactDirectories({ actualDir, expectedDir })).toEqual([
        ARTIFACT_FILENAMES.dot,
      ]);
    } finally {
      rmSync(actualDir, { force: true, recursive: true });
      rmSync(expectedDir, { force: true, recursive: true });
    }
  });
});
