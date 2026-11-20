/**
 * Host half of the background-jobs sidebar bundle.
 *
 * The panel is pure Client UI over the `jobs` Client service that
 * `@deepseek-ai/dsh-api-job-controller` installs, so this half owns no Host
 * resource. It exists so the bundle appears in the profile inventory with its
 * locale resources and artwork, and so the Client module has a row to ship
 * with.
 */
export function apply() {}
