'use strict';

/**
 * projectPageSummarySchema.cjs — hand-authored JSON Schema description of
 * `ProjectPageSummary` (src/renderer/lib/projectPages/summaryType.ts), for
 * the /admin/project-home/contract route (PRD: project-home-admin-routes).
 *
 * This schema is DESCRIPTIVE, not the enforcement mechanism — the actual
 * gate a posted summary must pass is `validateProjectPageSummary` (shipped
 * in scripts/project-pages-logic/dist/logic.cjs, called by
 * /admin/project-home/validate-summary and /admin/project-home/render).
 * Kept hand-written rather than derived at runtime so the contract route
 * never needs to load the TypeScript source; if summaryType.ts's shape
 * changes, update this alongside it (same discipline as any other
 * TS-type-mirrored constant in this codebase).
 */

const PROJECT_PAGE_SUMMARY_JSON_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ProjectPageSummary',
  type: 'object',
  required: ['identity', 'stats', 'pillars', 'feature', 'architecture', 'quotes'],
  properties: {
    identity: {
      type: 'object',
      required: ['name', 'tag', 'version', 'oneLine', 'claim', 'sub', 'audience', 'install'],
      properties: {
        name: { type: 'string' },
        tag: { type: 'string' },
        version: { type: 'string' },
        oneLine: { type: 'string' },
        claim: { type: 'string' },
        sub: { type: 'string' },
        audience: { type: 'string' },
        install: { type: 'string' },
      },
      description: 'Every string field must be non-empty and must not be the literal "TODO".',
    },
    stats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['v', 'k', 'n'],
        properties: { v: { type: 'string' }, k: { type: 'string' }, n: { type: 'string' } },
      },
    },
    pillars: {
      type: 'array',
      items: {
        type: 'object',
        required: ['t', 'd', 'k'],
        properties: { t: { type: 'string' }, d: { type: 'string' }, k: { type: 'string' } },
      },
    },
    quotes: {
      type: 'array',
      description: 'Never fabricate testimonials — omit entirely rather than invent a quote.',
      items: {
        type: 'object',
        required: ['q', 'a', 'r'],
        properties: { q: { type: 'string' }, a: { type: 'string' }, r: { type: 'string' } },
      },
    },
    feature: {
      type: 'object',
      required: ['name', 'kicker', 'status', 'owner', 'oneLine', 'problem', 'solution', 'steps', 'rules', 'specs', 'faq', 'timeline'],
      properties: {
        name: { type: 'string' },
        kicker: { type: 'string' },
        status: { type: 'string' },
        owner: { type: 'string' },
        oneLine: { type: 'string' },
        problem: { type: 'string' },
        solution: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', required: ['t', 'd'], properties: { t: { type: 'string' }, d: { type: 'string' } } } },
        rules: { type: 'array', items: { type: 'object', required: ['t', 'd'], properties: { t: { type: 'string' }, d: { type: 'string' } } } },
        specs: { type: 'array', items: { type: 'array', description: '[label, value, note]', items: { type: 'string' }, minItems: 3, maxItems: 3 } },
        faq: { type: 'array', items: { type: 'object', required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
        timeline: {
          type: 'array',
          items: {
            type: 'object',
            required: ['w', 't', 's'],
            properties: { w: { type: 'string' }, t: { type: 'string' }, s: { type: 'string', enum: ['done', 'next', 'idea'] } },
          },
        },
      },
    },
    architecture: {
      type: 'object',
      required: ['summary', 'principles', 'layers', 'modules', 'flow', 'decisions', 'risks'],
      properties: {
        summary: { type: 'string' },
        principles: { type: 'array', items: { type: 'object', required: ['t', 'd'], properties: { t: { type: 'string' }, d: { type: 'string' } } } },
        layers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['n', 'd', 'f', 'tone'],
            properties: { n: { type: 'string' }, d: { type: 'string' }, f: { type: 'string' }, tone: { type: 'string', enum: ['accent', 'butter', 'sage', 'mute'] } },
          },
        },
        modules: {
          type: 'array',
          items: {
            type: 'object',
            required: ['n', 'd', 'f', 'dep', 'heat'],
            properties: { n: { type: 'string' }, d: { type: 'string' }, f: { type: 'number' }, dep: { type: 'array', items: { type: 'string' } }, heat: { type: 'number' } },
          },
        },
        flow: {
          type: 'array',
          items: {
            type: 'object',
            required: ['a', 'b', 't', 'n'],
            properties: { a: { type: 'string' }, b: { type: 'string' }, t: { type: 'string' }, n: { type: 'string' } },
          },
        },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 't', 'w', 's'],
            properties: { id: { type: 'string' }, t: { type: 'string' }, w: { type: 'string' }, s: { type: 'string', enum: ['accepted', 'proposed', 'superseded'] } },
          },
        },
        risks: {
          type: 'array',
          description: 'No clean source in the Brief — leave empty rather than invent.',
          items: {
            type: 'object',
            required: ['t', 'd', 's'],
            properties: { t: { type: 'string' }, d: { type: 'string' }, s: { type: 'string', enum: ['open', 'watching', 'mitigated'] } },
          },
        },
      },
    },
    brief: {
      type: 'object',
      description: 'OPTIONAL — omit entirely when this project has no generated brief.json yet.',
      required: ['purpose', 'what', 'areas', 'scope', 'conventions'],
      properties: {
        purpose: { type: 'string' },
        what: { type: 'array', items: { type: 'string' } },
        areas: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'files', 'note', 'epic', 'heat'],
            properties: { name: { type: 'string' }, files: { type: 'number' }, note: { type: 'string' }, epic: { type: ['string', 'null'] }, heat: { type: 'number' } },
          },
        },
        scope: {
          type: 'array',
          items: {
            type: 'object',
            required: ['when', 'kind', 'text', 'src'],
            properties: { when: { type: 'string' }, kind: { type: 'string', enum: ['added', 'narrowed', 'decided'] }, text: { type: 'string' }, src: { type: 'string' } },
          },
        },
        conventions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
});

// ProjectPagePicks — Record<lensId, Record<slotId, variantId>>. Matched
// against each lens's own catalog.slots[].variants[].id at render time by
// the renderer bundle itself, so this schema only bounds the wire shape.
const PROJECT_PAGE_PICKS_JSON_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ProjectPagePicks',
  type: 'object',
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  description: 'lensId -> slotId -> variantId. Every lensId/slotId/variantId must match one from the catalog.',
});

module.exports = { PROJECT_PAGE_SUMMARY_JSON_SCHEMA, PROJECT_PAGE_PICKS_JSON_SCHEMA };
