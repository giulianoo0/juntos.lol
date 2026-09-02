/**
 * Limits both routes agree on. A leaf module rather than a constant exported
 * from a page: the room importing it from Home made the room's chunk depend
 * on the home's chunk by name, which is most of what route splitting is for.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024
