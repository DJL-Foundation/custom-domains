import { Data, Effect } from "effect";

// An Error that Marks a Case that Should Never Happen
// Parent Error for the Specific ones.
export class DefectiveLogic extends Data.TaggedError("DefectiveLogic")<{
  functionName: string;
  details?: string;
  path?: string;
}> {}

// Effect checks smth; fails but Typescript still thinks the returntype contains the Error
export class TypescriptVSEffectError extends Data.TaggedError(
  "TypescriptVSEffectError",
)<{
  // In plaintext where in what logic part the code is
  location?: string;
  // path including pathshorteners (~/src/...) and ":functionName"
  path?: string;
}> {}

type DefectiveWtfErrors = TypescriptVSEffectError;

type ConvertDefectiveError<E> = [Extract<E, DefectiveWtfErrors>] extends [never]
  ? E
  : Exclude<E, DefectiveWtfErrors> | DefectiveLogic;

const isDefectiveWtfError = (error: unknown): error is DefectiveWtfErrors =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag?: string })._tag === "TypescriptVSEffectError";

/**
 * Pipeable converter that removes TypescriptVSEffectError from the error channel
 * by turning it into DefectiveLogic.
 *
 * Usage:
 * Effect.something(...)
 *   .pipe(convertDefective)
 */
export const convertDefective = <R, E, A>(
   effect: Effect.Effect<A, E, R>,
 ): Effect.Effect<A, ConvertDefectiveError<E>, R> => {
   return effect.pipe(
     Effect.mapError((error) =>
       isDefectiveWtfError(error)
         ? new DefectiveLogic({
             functionName: "TypescriptVSEffectError",
             details: `TypescriptVSEffectError caught where it should be impossible${
               error.location ? ` @ ${error.location}` : ""
             }`,
             path: error.path,
           })
         : (error as E),
     ),
   ) as Effect.Effect<A, ConvertDefectiveError<E>, R>;
 };

/**
 * Optional explicit helper if you prefer a named function in pipes.
 */
export function withDefectiveConversion<R, E, A>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ConvertDefectiveError<E>, R> {
  return convertDefective(effect);
}

/**
 * Pipeable helper that catches DefectiveLogic errors and dies.
 * Useful at the edge of your program where you want to crash on logic errors.
 * Removes DefectiveLogic from the error type.
 */
export function killDefectiveLogic<R, E, A>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, DefectiveLogic>, R> {
  return effect.pipe(
    Effect.catchAll((error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag?: string })._tag === "DefectiveLogic"
        ? Effect.die(error)
        : Effect.fail(error as Exclude<E, DefectiveLogic>),
    ),
  ) as Effect.Effect<A, Exclude<E, DefectiveLogic>, R>;
}
