import type { VenueId } from '../config/venues.js';

type CanonicalContractId = string;

interface ContractMapping {
  canonicalId: CanonicalContractId;
  venue: VenueId;
  venueContractId: string;
}

export class ContractMapper {
  private byVenue = new Map<VenueId, Map<string, CanonicalContractId>>();

  constructor(mappings: ContractMapping[]) {
    for (const mapping of mappings) {
      const venueMap = this.byVenue.get(mapping.venue) ?? new Map();
      venueMap.set(mapping.venueContractId, mapping.canonicalId);
      this.byVenue.set(mapping.venue, venueMap);
    }
  }

  resolve(venue: VenueId, venueContractId: string): CanonicalContractId | null {
    const venueMap = this.byVenue.get(venue);
    if (!venueMap) return null;
    return venueMap.get(venueContractId) ?? null;
  }

  areEquivalent(a: { venue: VenueId; contractId: string }, b: { venue: VenueId; contractId: string }): boolean {
    const aCanonical = this.resolve(a.venue, a.contractId);
    const bCanonical = this.resolve(b.venue, b.contractId);
    if (!aCanonical || !bCanonical) return false;
    return aCanonical === bCanonical;
  }
}
