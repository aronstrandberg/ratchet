import { expect, test } from "bun:test"
import { Option } from "effect"
import { BuildAddressRef, parseBuildAddress } from "./build.ts"

test("a Buildkite build address is parsed into its organization, pipeline and positive build number", () => {
  expect(parseBuildAddress("https://buildkite.com/lovable/bazel/builds/123")).toEqual(
    Option.some(BuildAddressRef.make({ organization: "lovable", pipeline: "bazel", number: 123 })),
  )
})

test("a job fragment and trailing whitespace are ignored", () => {
  expect(parseBuildAddress("https://buildkite.com/lovable/bazel/builds/123#019abc-job-id \n")).toEqual(
    Option.some(BuildAddressRef.make({ organization: "lovable", pipeline: "bazel", number: 123 })),
  )
})

test("other hosts, extra paths, and non-positive, non-numeric or unsafe build numbers are refused", () => {
  const malformed = [
    "https://example.com/lovable/bazel/builds/123",
    "https://buildkite.com/lovable/bazel/builds/123/jobs",
    "https://buildkite.com/lovable/bazel/builds/not-a-number",
    "https://buildkite.com/lovable/bazel/builds/0",
    "https://buildkite.com/lovable/bazel/builds/9007199254740992",
  ]

  for (const address of malformed) expect(parseBuildAddress(address)).toEqual(Option.none())
})
