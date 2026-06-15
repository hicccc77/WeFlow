declare module '@nodert-win10-rs4/windows.security.credentials.ui' {
    export enum UserConsentVerificationResult {
        Verified = 0,
        DeviceNotPresent = 1,
        NotConfiguredForUser = 2,
        DisabledByPolicy = 3,
        DeviceBusy = 4,
        RetriesExhausted = 5,
        Canceled = 6
    }

    export enum UserConsentVerifierAvailability {
        Available = 0,
        DeviceNotPresent = 1,
        NotConfiguredForUser = 2,
        DisabledByPolicy = 3,
        DeviceBusy = 4
    }

    export class UserConsentVerifier {
        static checkAvailabilityAsync(callback: (err: Error | null, availability: UserConsentVerifierAvailability) => void): void;
        static requestVerificationAsync(message: string, callback: (err: Error | null, result: UserConsentVerificationResult) => void): void;
    }
}
