import { describe, expect, it } from 'vitest';
import {
  additionalRegistryModels,
  findRegistryModel,
  parseClaudeModelCatalog,
  reasoningEffortsFromCapabilities,
} from '../electron/claude-model-registry';

/**
 * Een fragment in exact de vorm waarin Claude Code zijn catalogus bundelt:
 * ongequote sleutels, `!0` voor `true`, exponentnotatie en een unicode-escape.
 */
const bundleFragment = [
  'var Ejo={"//":"Hand-maintained baked-in model catalog \\u2014 the source of truth",',
  'schema_version:1,pricing_tiers:{tier_5_25:{input:5,output:25}},',
  'models:[',
  '{id:"claude-3-5-haiku",family:"haiku",display_name:"Haiku 3.5",',
  'provider_ids:{first_party:"claude-3-5-haiku-20241022",anthropic_google_cloud:null},',
  'max_output_tokens:{default:8192,upper:8192},pricing:"haiku_35",capabilities:[]},',
  '{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",knowledge_cutoff:"February 2025",',
  'provider_ids:{first_party:"claude-haiku-4-5-20251001"},',
  'context:{window:200000,supports_1m_suffix:!0},max_output_tokens:{default:32000,upper:64000},',
  'capabilities:["context_management"],advisor_rank:1},',
  '{id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6",',
  'provider_ids:{first_party:"claude-sonnet-4-6"},context:{window:200000},',
  'max_output_tokens:{default:32000,upper:64000},',
  'capabilities:["effort","max_effort","adaptive_thinking","context_management"]},',
  '{id:"claude-opus-4-5",family:"opus",display_name:"Opus 4.5",',
  'provider_ids:{first_party:"claude-opus-4-5-20251101"},context:{window:200000},',
  'max_output_tokens:{default:32000,upper:64000},capabilities:["context_management"]},',
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",',
  'provider_ids:{first_party:"claude-opus-5"},context:{window:1e6,native_1m:!0},',
  'max_output_tokens:{default:64000,upper:128000},',
  'capabilities:["effort","max_effort","xhigh_effort","fast_mode"],',
  'image_limits:{maxWidth:2000,maxHeight:2000},effort_cost_index:{low:0.67,high:1}}',
  ']};function next(){}',
].join('');

describe('Claude Code modelcatalogus uit de binary', () => {
  it('leest de gebundelde catalogus inclusief bundler-notatie', () => {
    const models = parseClaudeModelCatalog(bundleFragment);

    expect(models.map((model) => model.id)).toEqual([
      'claude-3-5-haiku',
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
      'claude-opus-5',
    ]);
    expect(models[4]).toMatchObject({
      displayName: 'Opus 5',
      family: 'opus',
      firstPartyId: 'claude-opus-5',
      contextWindow: 1_000_000,
      maxOutputTokens: 64000,
    });
    expect(models[0].contextWindow).toBeUndefined();
  });

  it('geeft niets terug als de bundle er anders uitziet', () => {
    expect(parseClaudeModelCatalog('var x={models:[{id:"claude-a",family:"a"')).toEqual([]);
    expect(parseClaudeModelCatalog('geen catalogus hier')).toEqual([]);
    // Te weinig plausibele modellen telt als een toevallige treffer.
    expect(parseClaudeModelCatalog('models:[{id:"claude-x",family:"x",display_name:"X"}]')).toEqual([]);
  });

  it('leidt effortniveaus af uit de capabilities die het model zelf meldt', () => {
    expect(reasoningEffortsFromCapabilities(['context_management'])).toEqual([]);
    expect(reasoningEffortsFromCapabilities(['effort', 'max_effort']))
      .toEqual(['low', 'medium', 'high', 'max']);
    expect(reasoningEffortsFromCapabilities(['effort', 'max_effort', 'xhigh_effort']))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('vult alleen modellen aan die de SDK niet publiceert maar wel effort kennen', () => {
    const registry = parseClaudeModelCatalog(bundleFragment);

    // De SDK meldde opus (resolved naar claude-opus-5) en haiku al.
    expect(additionalRegistryModels(registry, ['claude-opus-5', 'claude-haiku-4-5-20251001'])
      .map((model) => model.id)).toEqual(['claude-sonnet-4-6']);
    // Nieuwste bovenaan: de catalogusvolgorde omgekeerd.
    expect(additionalRegistryModels(registry, []).map((model) => model.id))
      .toEqual(['claude-opus-5', 'claude-sonnet-4-6']);
  });

  it('koppelt SDK-waarden aan de catalogus via gedateerde en 1m-varianten', () => {
    const registry = parseClaudeModelCatalog(bundleFragment);

    expect(findRegistryModel(registry, 'claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
    expect(findRegistryModel(registry, 'claude-opus-5', 'opus')?.displayName).toBe('Opus 5');
    expect(findRegistryModel(registry, 'claude-opus-5[1m]')?.id).toBe('claude-opus-5');
    expect(findRegistryModel(registry, undefined, 'onbekend')).toBeUndefined();
  });
});
