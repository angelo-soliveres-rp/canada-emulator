import { describe, it, expect } from 'vitest';
import {
  extractTriggersCompleters,
  isLegitimateAd,
  orderAds,
  isInteractiveTemplate,
  type AdTriggersCompleters,
} from './adTriggers';

describe('extractTriggersCompleters', () => {
  it('pulls trigger UPCs from adtriggerconditions[].items (string UPCs)', () => {
    const r = extractTriggersCompleters({
      id: 42,
      name: '7up points club test',
      adtriggers: [{ adtriggerconditions: [{ items: ['028200009654', '012000001291'] }] }],
    });
    expect(r.name).toBe('7up points club test');
    expect(r.triggers.map((t) => t.code)).toEqual(['028200009654', '012000001291']);
  });

  it('pulls completer items (objects with code + description)', () => {
    const r = extractTriggersCompleters({
      id: 1,
      name: 'Combo',
      adcompleters: [
        { completercode: 'Completer 1', items: [{ code: '049000050110', description: 'Diet Coke 2lt' }] },
      ],
    });
    expect(r.completers).toEqual([{ code: '049000050110', description: 'Diet Coke 2lt' }]);
  });

  it('reads item codes from condition upc / itemcode / couponupc with descriptions', () => {
    const r = extractTriggersCompleters({
      name: 'CouponAd',
      adcompleters: [
        {
          adcompleterconditions: [
            { upc: '111', itemdescription: 'Thing' },
            { itemcode: '222', description: 'Other' },
            { couponupc: '95365' },
          ],
        },
      ],
    });
    expect(r.completers).toEqual([
      { code: '111', description: 'Thing' },
      { code: '222', description: 'Other' },
      { code: '95365' },
    ]);
  });

  it('dedupes by code and backfills a missing description', () => {
    const r = extractTriggersCompleters({
      name: 'Dup',
      adtriggers: [
        { items: ['123'], adtriggerconditions: [{ upc: '123', itemdescription: 'Coke' }] },
      ],
    });
    expect(r.triggers).toEqual([{ code: '123', description: 'Coke' }]);
  });

  it('falls back to id then a placeholder when name is missing', () => {
    expect(extractTriggersCompleters({ id: 7 }).name).toBe('7');
    expect(extractTriggersCompleters({}).name).toBe('(unnamed ad)');
  });

  it('returns empty arrays for an ad with no triggers/completers', () => {
    const r = extractTriggersCompleters({ id: 1, name: 'Plain' });
    expect(r.triggers).toEqual([]);
    expect(r.completers).toEqual([]);
  });

  it('surfaces the template name', () => {
    expect(extractTriggersCompleters({ id: 1, name: 'X', templatename: 'Basket Offer' }).template).toBe('Basket Offer');
    expect(extractTriggersCompleters({ id: 2, name: 'Y' }).template).toBe('');
  });
});

describe('isInteractiveTemplate', () => {
  it('is false for Static Image Or Video and empty/unknown', () => {
    expect(isInteractiveTemplate('Static Image Or Video')).toBe(false);
    expect(isInteractiveTemplate('static image or video')).toBe(false);
    expect(isInteractiveTemplate('')).toBe(false);
    expect(isInteractiveTemplate(undefined)).toBe(false);
  });

  it('is true for microsite templates', () => {
    expect(isInteractiveTemplate('Basket Offer')).toBe(true);
    expect(isInteractiveTemplate('2 Or 3 For')).toBe(true);
    expect(isInteractiveTemplate('Combo')).toBe(true);
  });
});

describe('orderAds', () => {
  it('sorts by name case-insensitively without mutating input', () => {
    const input: AdTriggersCompleters[] = [
      { id: '2', name: 'ckmw Amp', triggers: [], completers: [] },
      { id: '1', name: '7up points', triggers: [], completers: [] },
      { id: '3', name: 'Cashew', triggers: [], completers: [] },
    ];
    expect(orderAds(input).map((a) => a.name)).toEqual(['7up points', 'Cashew', 'ckmw Amp']);
    expect(input[0].name).toBe('ckmw Amp'); // original order preserved
  });
});

describe('isLegitimateAd', () => {
  it('rejects config entries stored in the ads collection', () => {
    // The ads collection also holds config docs whose templatename ends in
    // "Config" (Beat The Target Config, Top 5 Promos Config…). They are not ads.
    expect(isLegitimateAd({ templatename: 'Beat The Target Config' })).toBe(false);
    expect(isLegitimateAd({ templatename: 'Top 5 Promos Config' })).toBe(false);
    expect(isLegitimateAd({ templatename: '  config  ' })).toBe(false);
  });

  it('rejects a doc with no templatename at all', () => {
    expect(isLegitimateAd({})).toBe(false);
    expect(isLegitimateAd({ templatename: '' })).toBe(false);
    expect(isLegitimateAd({ templatename: '   ' })).toBe(false);
  });

  it('keeps real ads, including templates that merely contain "config"', () => {
    expect(isLegitimateAd({ templatename: 'Basket Offer' })).toBe(true);
    expect(isLegitimateAd({ templatename: '2 Or 3 For' })).toBe(true);
    expect(isLegitimateAd({ templatename: 'Configurable Combo' })).toBe(true);
  });
});
