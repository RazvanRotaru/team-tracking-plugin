export type DomainErrorKind =
  | "EPARENT"
  | "ETYPE_IMMUTABLE"
  | "ESTATUS"
  | "ELOCKED"
  | "EBADTOKEN"
  | "ENOTLOCKED"
  | "EADAPTER_UNREACHABLE"
  | "ENOTCONFIGURED"
  | "ENOTFOUND";

export type DomainError = {
  kind: DomainErrorKind;
  message: string;
};

export const domainErr = (kind: DomainErrorKind, message: string): DomainError => ({
  kind,
  message,
});
