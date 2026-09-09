import { describe, expect, it } from "vitest";
import { cleanProblemBody } from "./htmlClean.mts";

describe("cleanProblemBody", () => {
  it("strips simple HTML tags and keeps the text", () => {
    expect(cleanProblemBody("<p>What is 45 - 17?</p>")).toBe("What is 45 - 17?");
  });

  it("inserts a space at block boundaries so words don't get mashed together", () => {
    expect(cleanProblemBody("<p>First sentence.</p><p>Second sentence.</p>")).toBe("First sentence. Second sentence.");
  });

  it("converts <br> to a space", () => {
    expect(cleanProblemBody("Line one.<br/>Line two.")).toBe("Line one. Line two.");
  });

  it("decodes common named HTML entities", () => {
    expect(cleanProblemBody("<p>3 &lt; 5 &amp; 5 &gt; 3</p>")).toBe("3 < 5 & 5 > 3");
  });

  it("decodes numeric and hex HTML entities", () => {
    expect(cleanProblemBody("5 &#215; 3")).toBe("5 × 3");
    expect(cleanProblemBody("5 &#xD7; 3")).toBe("5 × 3");
  });

  it("converts a simple MathML fraction to linear a/b text", () => {
    expect(cleanProblemBody("<mfrac><mn>3</mn><mn>4</mn></mfrac>")).toBe("3/4");
  });

  it("converts a simple MathML superscript to linear a^b text", () => {
    expect(cleanProblemBody("<msup><mn>2</mn><mn>3</mn></msup>")).toBe("2^3");
  });

  it("converts MathML operator entities to plain symbols", () => {
    expect(cleanProblemBody("5 &minus; 3")).toBe("5 - 3");
    expect(cleanProblemBody("5 &divide; 3")).toBe("5 ÷ 3");
  });

  it("collapses repeated whitespace and trims", () => {
    expect(cleanProblemBody("  <p>  spaced   out  </p>  ")).toBe("spaced out");
  });

  it("strips nested/attributed tags", () => {
    expect(cleanProblemBody('<div class="problem"><span style="color:red">45 - 17</span></div>')).toBe("45 - 17");
  });
});
