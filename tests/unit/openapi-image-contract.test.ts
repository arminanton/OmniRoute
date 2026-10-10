import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import { extractUpscaleSourceImage } from "../../open-sse/handlers/imageUpscale/shared.ts";
import { v1ImageUpscaleSchema } from "../../src/shared/validation/schemas/apiV1.ts";

const openapi = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as any;

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
}

function assertErrorSchema(pathname: string, status: string): void {
  const response = openapi.paths[pathname]?.post?.responses?.[status];
  assert.ok(response, `${pathname} documents HTTP ${status}`);
  assert.equal(
    response.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse",
    `${pathname} HTTP ${status} uses the standard error envelope`
  );
}

test("image routes document cancellation and provider-side payload rejection accurately", () => {
  const paths = [
    "/api/v1/images/generations",
    "/api/v1/providers/{provider}/images/generations",
    "/api/v1/images/upscale",
  ];
  for (const pathname of paths) {
    assertErrorSchema(pathname, "499");
    assertErrorSchema(pathname, "413");
    assert.match(
      openapi.paths[pathname].post.responses["413"].description,
      /upstream image provider rejected[\s\S]*does not impose a body-size cap/i,
      `${pathname} describes provider-side rejection rather than a local cap`
    );
  }

  const bodyGuard = read("src/shared/middleware/bodySizeGuard.ts");
  assert.match(bodyGuard, /MAX_BODY_BYTES_MEDIA\s*=\s*Number\.POSITIVE_INFINITY/);
  assert.match(bodyGuard, /prefix:\s*"\/api\/v1\/images",\s*limit:\s*MAX_BODY_BYTES_MEDIA/);
  assert.match(bodyGuard, /PROVIDER_IMAGE_GENERATION_ROUTE[\s\S]*?return MAX_BODY_BYTES_MEDIA/);

  const imageRoute = read("src/app/api/v1/images/generations/route.ts");
  const providerImageRoute = read(
    "src/app/api/v1/providers/[provider]/images/generations/route.ts"
  );
  const upscaleRoute = read("src/app/api/v1/images/upscale/route.ts");
  assert.match(imageRoute, /signal:\s*request\.signal/);
  assert.match(providerImageRoute, /request\.signal\?\.aborted\s*\?\s*499\s*:\s*503/);
  assert.match(upscaleRoute, /signal:\s*request\.signal/);
});

test("upscale multipart schema matches accepted image sources and scalar controls", () => {
  const multipart =
    openapi.paths["/api/v1/images/upscale"].post.requestBody.content["multipart/form-data"].schema;
  assert.deepEqual(multipart.required, ["model"]);
  assert.ok(multipart.properties.image_url, "image_url is a documented multipart input");
  assert.ok(
    multipart.anyOf.some((branch: { required?: string[] }) => branch.required?.includes("image"))
  );
  assert.ok(
    multipart.anyOf.some((branch: { required?: string[] }) =>
      branch.required?.includes("image_url")
    )
  );
  assert.ok(
    multipart.anyOf.some((branch: { required?: string[] }) =>
      branch.required?.includes("image_urls")
    )
  );

  for (const field of ["image", "image_url"]) {
    const alternatives = multipart.properties[field].anyOf;
    assert.ok(alternatives.some((branch: { type?: string }) => branch.type === "string"));
    assert.ok(
      alternatives.some(
        (branch: { type?: string; format?: string }) =>
          branch.type === "string" && branch.format === "binary"
      ),
      `${field} allows an uploaded file`
    );
  }
  for (const field of ["factor", "creativity"]) {
    const alternatives = multipart.properties[field].oneOf;
    assert.ok(alternatives.some((branch: { type?: string }) => branch.type === "number"));
    assert.ok(alternatives.some((branch: { type?: string }) => branch.type === "string"));
  }

  const valid = {
    model: "topaz/topaz-enhance",
    image_url: "https://images.example/source.png",
    factor: 2,
    creativity: 0.4,
  };
  assert.equal(v1ImageUpscaleSchema.safeParse(valid).success, true);
  assert.equal(extractUpscaleSourceImage(valid), valid.image_url);

  const route = read("src/app/api/v1/images/upscale/route.ts");
  assert.match(route, /for \(const \[key, value\] of formData\.entries\(\)\)/);
  assert.match(route, /body\[key\]\s*=\s*`data:\$\{mime\};base64,/);
});
