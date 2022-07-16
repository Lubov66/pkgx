import { Package, PackageRequirement, Path, PlainObject, SemVer, semver } from "types"
import useGitHubAPI from "hooks/useGitHubAPI.ts"
import { run, flatMap, isNumber, isPlainObject, isString, isArray, isPrimitive, undent, isBoolean } from "utils"
import useCellar from "hooks/useCellar.ts"
import usePlatform from "hooks/usePlatform.ts"


interface Response {
  getDistributable(rq: Package): Promise<{ url: string, stripComponents?: number }>
  /// returns sorted versions
  getVersions(rq: PackageRequirement | Package): Promise<SemVer[]>
  getDeps(pkg: Package | PackageRequirement): Promise<{ runtime: PackageRequirement[], build: PackageRequirement[] }>
  getBuildScript(pkg: Package): Promise<string>
  update(): Promise<void>
  getProvides(rq: PackageRequirement | Package): Promise<string[]>
}

interface Entry {
  dir: Path
  yml: () => Promise<PlainObject>
  versions: Path
}

const prefix = new Path("/opt/tea.xyz/var/pantry/projects")

export default function usePantry(): Response {
  const getVersions = async (pkg: PackageRequirement) => {
    const files = entry(pkg)
    const foo = (await files.yml()).versions
    if (isArray(foo)) {
      if (foo.length > 5) throw "use-versions.txt-if-more-than-5-versions"
      return foo.map(x => new SemVer(x))
    }
    let rv: SemVer[]
    if (await txt()) return rv!
    if (await github()) return rv!.sort()
    throw "no-versions"

    async function txt(): Promise<boolean> {
      if (!files.versions.isReadableFile()) return false
      const txt = await files.versions.read()
      rv = txt.split(/\w+/).map(x => new SemVer(x)).sort()
      return true
    }

    async function github(): Promise<boolean> {
      const yml = await files.yml()
      const ignoredVersions = yml['ignore-versions']?.map((v: string) => new RegExp(v))
      try {
        const { user, repo } = get()
        rv = await useGitHubAPI().getVersions({ user, repo, ignoredVersions })
        return true
      } catch (err) {
        if (err === "not-github") return false
        throw err
      }

      function get() {
        if (isString(yml.versions?.github)) {
          const [user, repo] = yml.versions.github.split("/")
          return { user, repo }
        } else {
          const url = new URL(getRawDistributableURL(yml))
          if (url.host != "github.com") throw "not-github"
          const [, user, repo] = url.pathname.split("/")
          return { user, repo }
        }
      }
    }
  }

  const getDeps = async (pkg: Package | PackageRequirement) => {
    const yml =  await entry(pkg).yml()
    return {
      runtime: go(yml.dependencies),
      build: go(yml.build?.dependencies)
    }
    // deno-lint-ignore no-explicit-any
    function go(node: any) {
      if (!node) return []
      const rv: PackageRequirement[] = []
      const deps = validatePlainObject(node)
      for (const [project, rawconstraint] of Object.entries(deps)) {
        if (project == "cc") continue //FIXME
        if (project == "c++") continue //FIXME
        if (project == "tea.xyz") continue //FIXME
        console.debug(project, rawconstraint)
        const constraint = new semver.Range(`${rawconstraint}`)
        rv.push({ project, constraint })
      }
      return rv
    }
  }

  const getRawDistributableURL = (yml: PlainObject) => validateString(
      isPlainObject(yml.distributable)
        ? yml.distributable.url
        : yml.distributable)

  const getDistributable = async (pkg: Package) => {
    const yml = await entry(pkg).yml()
    let url = getRawDistributableURL(yml)
    let stripComponents: number | undefined
    if (isPlainObject(yml.distributable)) {
      url = validateString(yml.distributable.url)
      stripComponents = flatMap(yml.distributable["strip-components"], coerceNumber)
    } else {
      url = validateString(yml.distributable)
    }

    url = remapTokens(url, pkg)

    return { url, stripComponents }
  }

  const getBuildScript = async (pkg: Package) => {
    const yml = await entry(pkg).yml()
    let raw = validateString(validatePlainObject(yml.build).script)

    const wd = yml.build["working-directory"]
    if (wd) {
      raw = undent`
        mkdir -p ${wd}
        cd ${wd}

        ${raw}
        `
    }

    const env = yml.build.env
    if (isPlainObject(env)) {
      const expanded_env = Object.entries(env).map(([key,value]) => {
        if (isArray(value)) {
          value = value.map(transform).join(" ")
        } else {
          value = transform(value)
        }
        // weird POSIX string escaping/concat stuff
        // eg. export FOO="bar ""$baz"" bun"
        let rv = `export ${key}="${value.replace(/"/g, '""')}"`
        if (rv.startsWith("")) rv = rv.slice(1)  //FIXME lol better pls
        if (rv.endsWith("")) rv = rv.slice(0,-1) //FIXME lol better pls
        return rv
      }).join("\n")
      raw = `${expanded_env}\n\n${raw}`
    }

    return remapTokens(raw, pkg)

    function transform(value: any): string {
      if (!isPrimitive(value)) throw new Error("invalid-env-value")
      if (isBoolean(value)) {
        return value ? "1" : "0"
      } else if (value === undefined || value === null) {
        return "0"
      } else if (isString(value)) {
        return remapTokens(value, pkg)
      }
      throw new Error("unexpected-error")
    }
  }

  const remapTokens = (input: string, pkg: Package) => {
    const platform = usePlatform()
    const prefix = useCellar().mkpath(pkg)

    return [
      { from: "version", to: pkg.version.toString() },
      { from: "version.major", to: pkg.version.major.toString() },
      { from: "version.minor", to: pkg.version.minor.toString() },
      { from: "version.patch", to: pkg.version.patch.toString() },
      { from: "version.build", to: pkg.version.build.join('+') },
      { from: "hw.arch", to: platform.arch },
      { from: "hw.target", to: platform.target },
      { from: "hw.platform", to: platform.platform },
      { from: "prefix", to: prefix.string },
      { from: "hw.concurrency", to: navigator.hardwareConcurrency.toString() }
    ].reduce((acc, map) => acc.replace(new RegExp(`\\$?{{\\s*${map.from}\\s*}}`, "g"), map.to), input)
  }

  const update = async () => {
    await run({
      cmd: ["git", "-C", prefix, "pull", "origin", "HEAD", "--no-edit"]
    })
  }

  const getProvides = async (pkg: Package | PackageRequirement) => {
    const yml = await entry(pkg).yml()
    const node = yml["provides"]
    if (!isArray(node)) throw "bad-yaml"

    return node.compactMap(x => {
      if (isPlainObject(x)) {
        x = x["executable"]
      }
      if (isString(x)) {
        return x.startsWith("bin/") && x.slice(4)
      }
    })
  }

  return { getVersions, getDeps, getDistributable, getBuildScript, update, getProvides }
}


// deno-lint-ignore no-explicit-any
function validateString(input: any): string {
  if (typeof input != 'string') throw new Error(`not-string: ${input}`)
  return input
}

// deno-lint-ignore no-explicit-any
function validatePlainObject(input: any): PlainObject {
  if (!isPlainObject(input)) throw "not-plain-obj"
  return input
}

// deno-lint-ignore no-explicit-any
function coerceNumber(input: any) {
  if (isNumber(input)) return input
}

//TODO we have a better system in mind than git
async function installIfNecessary() {
  if (!prefix.exists()) {
    const cwd = prefix.parent().parent().mkpath()
    //FIXME before release, use https://
    await run({
      cmd: ["git", "clone", "https://github.com/teaxyz/pantry"],
      cwd
    })
  }
}

function entry(pkg: Package | PackageRequirement): Entry {
  const dir = prefix.join(pkg.project)
  const yml = async () => {
    await installIfNecessary()
    // deno-lint-ignore no-explicit-any
    const yml = await dir.join("package.yml").readYAML() as any
    if (!isPlainObject(yml)) throw "bad-yaml"
    return yml
  }
  const versions = dir.join("versions.txt")
  return { dir, yml, versions }
}
