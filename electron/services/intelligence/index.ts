/**
 * Intelligence module — unified export
 *
 * All intelligence services are exported from this index file.
 */

// Types
export * from './types'

// Database
export { IntelligenceDb, intelligenceDb, initializeIntelligenceDb } from './intelligenceDb'

// Services
export { LLMService, llmService } from './llmService'
export { MediaContextService, mediaContextService } from './mediaContextService'
export { ContentHubService, contentHubService } from './contentHubService'

// New services (Session 2)
export { BriefingService } from './briefingService'
export type { BriefingMessage, BriefingLLM, BriefingOutput } from './briefingService'

export { PuaDetectorService } from './puaDetectorService'
export type { PUAMessage, PUALLM } from './puaDetectorService'

export { GrowthAdvisorService } from './growthAdvisorService'
export type { GrowthMessage, GrowthLLM } from './growthAdvisorService'

export { PurchaseAdvisorService } from './purchaseAdvisorService'
export type { PurchaseMessage, PurchaseLLM } from './purchaseAdvisorService'
