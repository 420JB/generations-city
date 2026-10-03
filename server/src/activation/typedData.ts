import { getAddress, hashTypedData, type Hex } from 'viem'
import { ACTIVATION_DOMAIN_NAME, ACTIVATION_DOMAIN_VERSION, ACTIVATION_PRIMARY_TYPE, ACTIVATION_STATEMENT, ACTIVATION_TYPES, plotId, RARE_FRIENDS_CHAIN, type ActivationTypedData, type DistrictId, type Family } from '../engine'

/**
 * The one `PropertyActivation` message for an intent, and its EIP-712 hash.
 *
 * The server builds every field from what it knows: the session's wallet, the chain's
 * answer for the Friend's family, the city it read, its own origin and the database clock.
 * Nothing in it comes from the browser except the Friend and the plot that were asked for,
 * and both were checked before this is called.
 *
 * Hashing is viem's `hashTypedData`. Nothing here implements a hash or a curve.
 */
export interface IntentFacts {
  /** 64 lowercase hex characters. */
  intentId: string
  /** The origin the intent is issued for. */
  site: string
  /** The session's wallet, any casing. */
  wallet: string
  tokenId: bigint
  family: Family
  cityId: string
  cityInstance: string
  districtId: DistrictId
  ward: number
  plot: number
  issuedAt: Date
  expiresAt: Date
}

/** The message as JSON: exactly what the wallet is handed, with every large integer as a decimal string. */
export function activationTypedData(facts: IntentFacts): ActivationTypedData {
  return {
    domain: { name: ACTIVATION_DOMAIN_NAME, version: ACTIVATION_DOMAIN_VERSION, chainId: RARE_FRIENDS_CHAIN.chainId },
    types: ACTIVATION_TYPES,
    primaryType: ACTIVATION_PRIMARY_TYPE,
    message: {
      intentId: `0x${facts.intentId}`,
      site: facts.site,
      statement: ACTIVATION_STATEMENT,
      wallet: getAddress(facts.wallet),
      collection: getAddress(RARE_FRIENDS_CHAIN.generations),
      tokenId: facts.tokenId.toString(),
      familyId: facts.family.id,
      familyName: facts.family.name,
      cityId: facts.cityId,
      cityInstance: facts.cityInstance,
      districtId: facts.districtId,
      ward: facts.ward,
      plot: facts.plot,
      plotId: plotId(facts.districtId, facts.ward, facts.plot),
      issuedAt: String(facts.issuedAt.getTime()),
      expiresAt: String(facts.expiresAt.getTime()),
    },
  }
}

/** The EIP-712 hash of a message: the 32 bytes a wallet signs, and what the service stores and recovers against. */
export function activationDigest(typedData: ActivationTypedData): Hex {
  const { message } = typedData
  return hashTypedData({
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      ...message,
      intentId: message.intentId as Hex,
      wallet: getAddress(message.wallet),
      collection: getAddress(message.collection),
      tokenId: BigInt(message.tokenId),
      issuedAt: BigInt(message.issuedAt),
      expiresAt: BigInt(message.expiresAt),
    },
  })
}
