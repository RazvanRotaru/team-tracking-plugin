import { type DomainError, domainErr } from "./errors.js";
import { type Result, err, ok } from "./result.js";
import {
  type AllowedStatuses,
  type CreateTicketDTO,
  DEFAULT_ALLOWED_STATUSES,
  type TicketDTO,
  type TicketType,
  type UpdateDTO,
} from "./types.js";

export function allowedParentTypes(type: TicketType): readonly TicketType[] {
  switch (type) {
    case "epic":
      return [];
    case "story":
      return ["epic"];
    case "task":
      return ["story", "epic"];
    case "subtask":
      return ["task", "story"];
  }
}

export function isParentRequired(type: TicketType): boolean {
  return type === "subtask";
}

export function validateCreate(
  draft: Pick<CreateTicketDTO, "type" | "parent">,
  parent: { type: TicketType } | null,
): Result<void, DomainError> {
  if (parent && draft.type === "epic") {
    return err(domainErr("EPARENT", "epic cannot have a parent"));
  }

  if (!parent && isParentRequired(draft.type)) {
    return err(domainErr("EPARENT", `${draft.type} requires a parent`));
  }

  if (parent) {
    const allowed = allowedParentTypes(draft.type);
    if (!allowed.includes(parent.type)) {
      const allowedStr = allowed.length === 0 ? "(none)" : allowed.join(", ");
      return err(
        domainErr(
          "EPARENT",
          `${draft.type} cannot have ${parent.type} as parent (allowed: ${allowedStr})`,
        ),
      );
    }
  }

  return ok(undefined);
}

export function validateUpdate(
  current: Pick<TicketDTO, "type">,
  update: UpdateDTO & { type?: TicketType; parent?: unknown },
): Result<void, DomainError> {
  if ("type" in update && update.type !== undefined && update.type !== current.type) {
    return err(domainErr("ETYPE_IMMUTABLE", "type cannot change after creation"));
  }
  if ("parent" in update && update.parent !== undefined) {
    return err(domainErr("ETYPE_IMMUTABLE", "parent cannot change after creation"));
  }
  return ok(undefined);
}

export function validateStatusForType(
  type: TicketType,
  status: string,
  allowed: AllowedStatuses = DEFAULT_ALLOWED_STATUSES,
): Result<void, DomainError> {
  const set = allowed[type];
  if (!set.includes(status)) {
    return err(
      domainErr(
        "ESTATUS",
        `status "${status}" not allowed for ${type} (allowed: ${set.join(", ")})`,
      ),
    );
  }
  return ok(undefined);
}
