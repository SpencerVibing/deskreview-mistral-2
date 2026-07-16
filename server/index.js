import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PUBLIC_ROOT = join(ROOT, 'public');
const STATIC_ROOTS = new Map([
  ['/app/', join(ROOT, 'app')],
  ['/core/', join(ROOT, 'core')],
  ['/services/', join(ROOT, 'services')],
  ['/data/', join(ROOT, 'data')]
]);
const CONFIG_SOURCES = new Map();

await loadLocalEnv();

const PORT = Number(process.env.PORT || 8891);
const MISTRAL_BASE_URL = String(process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
const MISTRAL_OCR_MODEL = String(process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest').trim();
const MISTRAL_CHAT_MODEL = String(process.env.MISTRAL_CHAT_MODEL || 'mistral-small-latest').trim();
const MISTRAL_OCR_TIMEOUT_MS = Number(process.env.MISTRAL_OCR_TIMEOUT_MS || 180000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

async function loadLocalEnv() {
  const envFiles = [process.env.DESKREVIEW_ENV_FILE, join(ROOT, '.env')].filter(Boolean);
  for (const envFile of envFiles) {
    try {
      const content = await readFile(envFile, 'utf8');
      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const separator = trimmed.indexOf('=');
        if (separator <= 0) return;
        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        if (!key || process.env[key] !== undefined) return;
        process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
        CONFIG_SOURCES.set(key, envFile === join(ROOT, '.env') ? '.env' : 'DESKREVIEW_ENV_FILE');
      });
    } catch {
      // A local env file is optional; OCR requests still require MISTRAL_API_KEY.
    }
  }
}

function configSource(name = '') {
  if (CONFIG_SOURCES.has(name)) return CONFIG_SOURCES.get(name);
  if (process.env[name] !== undefined) return 'environment';
  return 'default';
}

function secretFingerprint(value = '') {
  const secret = String(value || '');
  if (!secret) return '';
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function logStartupDiagnostics() {
  const apiKey = String(process.env.MISTRAL_API_KEY || '');
  console.log('[deskreview-mistral-2] Mistral config', JSON.stringify({
    apiKey: apiKey
      ? {
          present: true,
          source: configSource('MISTRAL_API_KEY'),
          length: apiKey.length,
          fingerprint: secretFingerprint(apiKey)
        }
      : {
          present: false,
          source: 'missing'
        },
    baseUrl: {
      value: MISTRAL_BASE_URL,
      source: configSource('MISTRAL_BASE_URL')
    },
    ocrModel: {
      value: MISTRAL_OCR_MODEL,
      source: configSource('MISTRAL_OCR_MODEL')
    },
    chatModel: {
      value: MISTRAL_CHAT_MODEL,
      source: configSource('MISTRAL_CHAT_MODEL')
    },
    ocrTimeoutMs: MISTRAL_OCR_TIMEOUT_MS
  }));
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function mistralErrorMessage(raw = null, text = '', fallback = 'Mistral request failed.') {
  return raw?.error?.message || raw?.detail || raw?.message || text || fallback;
}

function mistralJsonSchema(name, schema) {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema
    }
  };
}

function groundedChatSchema() {
  return mistralJsonSchema('deskreview_grounded_chat', {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'citations'],
    properties: {
      answer: {
        type: 'string',
        description: 'Answer using inline citation markers such as [1].'
      },
      citations: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['marker', 'quote'],
          properties: {
            marker: {
              type: 'integer',
              minimum: 1,
              maximum: 6
            },
            quote: {
              type: 'string',
              description: 'An exact verbatim quote copied from the supplied manuscript context.'
            }
          }
        }
      }
    }
  });
}

function semanticCountsSchema() {
  return mistralJsonSchema('deskreview_semantic_counts', {
    type: 'object',
    additionalProperties: false,
    required: ['abstractWordCount', 'articleWordCount', 'referenceCount', 'warnings'],
    properties: {
      abstractWordCount: {
        type: 'integer',
        minimum: 0,
        description: 'Word count of the manuscript abstract only.'
      },
      articleWordCount: {
        type: 'integer',
        minimum: 0,
        description: 'Word count of the main article text, excluding abstract, references, captions, tables, figures, headers, footers, line numbers, page numbers, and supplement/back matter.'
      },
      referenceCount: {
        type: 'integer',
        minimum: 0,
        description: 'Number of bibliography entries in the reference list.'
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short warnings for missing or ambiguous manuscript sections. Empty when the counts are straightforward.'
      }
    }
  });
}

function ocrCountAnnotationSchema() {
  const sourceItem = {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'sourceBlockKeys'],
    properties: {
      text: { type: 'string' },
      sourceBlockKeys: { type: 'array', items: { type: 'string' } }
    }
  };
  return mistralJsonSchema('deskreview_article_element_counts_annotation', {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'metadata', 'abstract', 'article', 'references', 'warnings'],
    properties: {
      title: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sourceBlockKeys'],
        properties: {
          text: { type: 'string' },
          sourceBlockKeys: { type: 'array', items: { type: 'string' } }
        }
      },
      metadata: {
        type: 'object',
        additionalProperties: false,
        required: ['authors', 'affiliations', 'keywords', 'warnings'],
        properties: {
          authors: { type: 'array', items: sourceItem },
          affiliations: { type: 'array', items: sourceItem },
          keywords: { type: 'array', items: sourceItem },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      },
      abstract: {
        type: 'object',
        additionalProperties: false,
        required: ['countedText', 'wordCount', 'sourceBlockKeys', 'warnings'],
        properties: {
          countedText: { type: 'string' },
          wordCount: { type: 'integer', minimum: 0 },
          sourceBlockKeys: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      },
      article: {
        type: 'object',
        additionalProperties: false,
        required: ['wordCount', 'sections', 'warnings'],
        properties: {
          wordCount: { type: 'integer', minimum: 0 },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'countedText', 'sourceBlockKeys'],
              properties: {
                title: { type: 'string' },
                countedText: { type: 'string' },
                sourceBlockKeys: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      },
      references: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'entries', 'warnings'],
        properties: {
          count: { type: 'integer', minimum: 0 },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['number', 'rawText', 'sourceBlockKeys'],
              properties: {
                number: { type: 'integer', minimum: 1 },
                rawText: { type: 'string' },
                sourceBlockKeys: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      },
      warnings: { type: 'array', items: { type: 'string' } }
    }
  });
}

function referenceResolverSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_reference_resolver',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'warnings'],
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['number', 'rawReferenceText', 'sourceBlockKey', 'bibliographyAnchorQuote', 'citationMatchers'],
              properties: {
                number: { type: 'integer', minimum: 1 },
                rawReferenceText: {
                  type: 'string',
                  description: 'One complete copied bibliography entry. Do not merge multiple references.'
                },
                sourceBlockKey: {
                  type: 'string',
                  description: 'The OCR block key from which this reference entry was copied.'
                },
                bibliographyAnchorQuote: {
                  type: 'string',
                  description: 'A short exact substring from rawReferenceText suitable for locating the entry in the OCR block.'
                },
                citationMatchers: {
                  type: 'array',
                  description: 'Likely in-text citation forms for this reference, derived only from the reference entry.',
                  items: { type: 'string' }
                }
              }
            }
          },
          warnings: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  };
}

function countedTextResolverSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_counted_text_resolver',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['abstract', 'article', 'metadata', 'warnings'],
        properties: {
          abstract: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'countedText', 'excludedText', 'warnings'],
            properties: {
              label: { type: 'string' },
              countedText: { type: 'string' },
              excludedText: { type: 'array', items: { type: 'string' } },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          article: {
            type: 'object',
            additionalProperties: false,
            required: ['sections', 'excludedText', 'warnings'],
            properties: {
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'countedText', 'sourceBlockKeys'],
                  properties: {
                    title: { type: 'string' },
                    countedText: {
                      type: 'string',
                      description: 'Leave empty unless a single OCR block must be split to exclude non-article text.'
                    },
                    sourceBlockKeys: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'OCR block keys that contain counted main-article prose for this section.'
                    }
                  }
                }
              },
              excludedText: { type: 'array', items: { type: 'string' } },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          metadata: {
            type: 'object',
            additionalProperties: false,
            required: ['authors', 'affiliations', 'keywords', 'warnings'],
            properties: {
              authors: {
                type: 'array',
                description: 'Manuscript authors copied from the author byline. One item per person; split names joined by "and" and remove footnote/correspondence markers.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['text', 'sourceBlockKeys'],
                  properties: {
                    text: { type: 'string' },
                    sourceBlockKeys: { type: 'array', items: { type: 'string' } }
                  }
                }
              },
              affiliations: {
                type: 'array',
                description: 'Distinct affiliation entries copied from the manuscript front matter. One item per listed affiliation.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['text', 'sourceBlockKeys'],
                  properties: {
                    text: { type: 'string' },
                    sourceBlockKeys: { type: 'array', items: { type: 'string' } }
                  }
                }
              },
              keywords: {
                type: 'array',
                description: 'Individual manuscript keywords copied from the keyword list, or from Editorial Manager/submission cover metadata only when the manuscript has no keyword list. One item per keyword.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['text', 'sourceBlockKeys'],
                  properties: {
                    text: { type: 'string' },
                    sourceBlockKeys: { type: 'array', items: { type: 'string' } }
                  }
                }
              },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  };
}

function displayItemResolverSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_display_item_resolver',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'warnings'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['itemId', 'kind', 'label', 'isManuscriptItem', 'exclusionReason', 'sourceBlockKey', 'anchorQuote', 'citationOccurrences'],
              properties: {
                itemId: { type: 'string' },
                kind: { type: 'string', enum: ['table', 'figure'] },
                label: { type: 'string' },
                isManuscriptItem: {
                  type: 'boolean',
                  description: 'True only for tables/figures that are part of the submitted manuscript.'
                },
                exclusionReason: {
                  type: 'string',
                  description: 'Empty for manuscript items. For excluded items, briefly explain why, such as Editorial Manager cover-page metadata.'
                },
                sourceBlockKey: {
                  type: 'string',
                  description: 'OCR block key for the table/figure location. Use the provided item sourceBlockKey when available.'
                },
                anchorQuote: {
                  type: 'string',
                  description: 'Short copied text from the display item or its caption suitable for locating it.'
                },
                citationOccurrences: {
                  type: 'array',
                  description: 'Body-text locations where this table or figure is referenced.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['citationText', 'contextQuote', 'blockKey'],
                    properties: {
                      citationText: { type: 'string' },
                      contextQuote: {
                        type: 'string',
                        description: 'Short exact copied body-text passage around the table/figure citation.'
                      },
                      blockKey: {
                        type: 'string',
                        description: 'OCR body block key containing the citation.'
                      }
                    }
                  }
                }
              }
            }
          },
          warnings: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  };
}

function documentAnnotationSchema() {
  const textItem = {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'sourceBlockKeys'],
    properties: {
      text: { type: 'string' },
      sourceBlockKeys: { type: 'array', items: { type: 'string' } }
    }
  };
  const citationOccurrence = {
    type: 'object',
    additionalProperties: false,
    required: ['citationText', 'contextQuote', 'blockKey'],
    properties: {
      citationText: { type: 'string' },
      contextQuote: { type: 'string' },
      blockKey: { type: 'string' }
    }
  };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_document_annotation',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'frontMatter', 'abstract', 'article', 'references', 'displayItems', 'quoteAnchors', 'warnings'],
        properties: {
          title: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'sourceBlockKey', 'anchorQuote'],
            properties: {
              text: { type: 'string' },
              sourceBlockKey: { type: 'string' },
              anchorQuote: { type: 'string' }
            }
          },
          frontMatter: {
            type: 'object',
            additionalProperties: false,
            required: ['authors', 'affiliations', 'keywords'],
            properties: {
              authors: { type: 'array', items: textItem },
              affiliations: { type: 'array', items: textItem },
              keywords: { type: 'array', items: textItem }
            }
          },
          abstract: {
            type: 'object',
            additionalProperties: false,
            required: ['countedText', 'wordCount', 'sourceBlockKeys', 'warnings'],
            properties: {
              countedText: { type: 'string' },
              wordCount: { type: 'integer', minimum: 0 },
              sourceBlockKeys: { type: 'array', items: { type: 'string' } },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          article: {
            type: 'object',
            additionalProperties: false,
            required: ['wordCount', 'sections', 'warnings'],
            properties: {
              wordCount: { type: 'integer', minimum: 0 },
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'countedText', 'sourceBlockKeys'],
                  properties: {
                    title: { type: 'string' },
                    countedText: { type: 'string' },
                    sourceBlockKeys: { type: 'array', items: { type: 'string' } }
                  }
                }
              },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          references: {
            type: 'object',
            additionalProperties: false,
            required: ['entries', 'warnings'],
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['number', 'rawReferenceText', 'sourceBlockKey', 'bibliographyAnchorQuote', 'citationOccurrences'],
                  properties: {
                    number: { type: 'integer', minimum: 1 },
                    rawReferenceText: { type: 'string' },
                    sourceBlockKey: { type: 'string' },
                    bibliographyAnchorQuote: { type: 'string' },
                    citationOccurrences: { type: 'array', items: citationOccurrence }
                  }
                }
              },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          displayItems: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'warnings'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['itemId', 'kind', 'label', 'sourceBlockKey', 'anchorQuote', 'citationOccurrences'],
                  properties: {
                    itemId: { type: 'string' },
                    kind: { type: 'string', enum: ['table', 'figure'] },
                    label: { type: 'string' },
                    sourceBlockKey: { type: 'string' },
                    anchorQuote: { type: 'string' },
                    citationOccurrences: { type: 'array', items: citationOccurrence }
                  }
                }
              },
              warnings: { type: 'array', items: { type: 'string' } }
            }
          },
          quoteAnchors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'label', 'sourceBlockKey', 'quote'],
              properties: {
                kind: { type: 'string' },
                label: { type: 'string' },
                sourceBlockKey: { type: 'string' },
                quote: { type: 'string' }
              }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  };
}

function guidelineMatchSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_guideline_matches',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['matches', 'warnings'],
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['guidelineId', 'label', 'rationale', 'confidence', 'sourceBlockKey', 'anchorQuote'],
              properties: {
                guidelineId: { type: 'string' },
                label: { type: 'string' },
                rationale: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                sourceBlockKey: { type: 'string' },
                anchorQuote: { type: 'string' }
              }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  };
}

function essentialGuidelineEvaluationSchema() {
  const evidenceQuote = {
    type: 'object',
    additionalProperties: false,
    required: ['quote', 'sourceBlockKey'],
    properties: {
      quote: { type: 'string' },
      sourceBlockKey: { type: 'string' }
    }
  };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'deskreview_essential_guideline_evaluation',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['guides', 'warnings'],
        properties: {
          guides: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'status', 'results'],
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: ['present', 'warning', 'absent', 'optional', 'skipped', 'na'] },
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'status', 'message', 'evidenceQuotes', 'sourceBlockKey'],
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string', enum: ['present', 'warning', 'absent', 'optional', 'skipped', 'na'] },
                      message: { type: 'string' },
                      evidenceQuotes: { type: 'array', items: evidenceQuote },
                      sourceBlockKey: { type: 'string' }
                    }
                  }
                }
              }
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  };
}

function parseAnnotation(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function parseJsonContent(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleOcr(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to run OCR4.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const base64 = String(body.base64 || '').trim();
  if (!base64) {
    jsonResponse(res, { error: 'Missing PDF base64 payload.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_OCR_MODEL,
    document: {
      type: 'document_url',
      document_url: `data:${String(body.mimeType || 'application/pdf')};base64,${base64}`
    },
    include_blocks: true,
    include_image_base64: true,
    table_format: 'html'
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(MISTRAL_OCR_TIMEOUT_MS) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/ocr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral OCR request timed out.'
      : String(error?.message || error || 'Mistral OCR request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: mistralErrorMessage(raw, text, `Mistral OCR failed (${response.status}).`),
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_OCR_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    fileName: String(body.fileName || 'manuscript.pdf'),
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_OCR_MODEL,
    pages: Array.isArray(raw?.pages) ? raw.pages : [],
    semanticCounts: null,
    usage_info: raw?.usage_info || null
  });
}

async function handleOcrCountAnnotation(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to run OCR document annotation.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const base64 = String(body.base64 || '').trim();
  if (!base64) {
    jsonResponse(res, { error: 'Missing PDF base64 payload.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_OCR_MODEL,
    document: {
      type: 'document_url',
      document_url: `data:${String(body.mimeType || 'application/pdf')};base64,${base64}`
    },
    include_blocks: true,
    table_format: 'html',
    document_annotation_format: ocrCountAnnotationSchema(),
    document_annotation_prompt: [
      'Extract article element counts for a scientific manuscript.',
      'Return individual author names as separate authors; never return a joined byline as one author.',
      'When a byline joins people with "and", split the people into separate author items and remove footnote markers such as *, dagger symbols, superscripts, and correspondence symbols.',
      'Use the actual manuscript, not editorial-management cover-page metadata, unless manuscript front matter is missing.',
      'If the actual manuscript has no keyword list but an Editorial Manager or submission cover table has a Keywords field, use that Keywords field as backup and split it into individual keyword items.',
      'Count abstract words from the abstract only.',
      'Count main article words excluding abstract, references, captions, tables, figures, headers, footers, page numbers, and supplementary/back matter.',
      'Split bibliography entries into separate references even when OCR groups multiple references in one block.',
      'Keep countedText values concise enough for review while preserving source-grounded evidence.'
    ].join(' ')
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/ocr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral OCR count annotation timed out.'
      : String(error?.message || error || 'Mistral OCR count annotation request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral OCR count annotation failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_OCR_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    fileName: String(body.fileName || 'manuscript.pdf'),
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_OCR_MODEL,
    result: parseJsonContent(raw?.document_annotation),
    usage_info: raw?.usage_info || null,
    pageCount: Array.isArray(raw?.pages) ? raw.pages.length : 0
  });
}

async function handleResolveReferences(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to resolve references.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const blocks = Array.isArray(body.referenceBlocks) ? body.referenceBlocks : [];
  if (!blocks.length) {
    jsonResponse(res, { error: 'Missing OCR reference blocks.' }, 400);
    return;
  }
  const inferBibliographyRegion = Boolean(body.inferBibliographyRegion);

  const startedAt = Date.now();
  const selectedBlocks = inferBibliographyRegion ? blocks.slice(-24) : blocks.slice(0, 24);
  const referenceBlocks = selectedBlocks.map((block) => ({
    blockKey: String(block.blockKey || ''),
    pageNumber: Number(block.pageNumber || 0) || 0,
    text: String(block.text || '').slice(0, 12000)
  }));

  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: referenceResolverSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You split OCR bibliography text into individual reference-list entries.',
          'Return JSON only, conforming exactly to the schema.',
          inferBibliographyRegion
            ? 'The provided OCR context may include the end of the article before an unheaded bibliography. First infer where the bibliography entries start and end, then return only those bibliography entries.'
            : 'The provided OCR context is expected to contain bibliography text.',
          'Do not use body text and do not invent references.',
          'If an OCR block contains many references, split it into one entry per bibliography reference.',
          'A reference list can be unheaded; in that case recognize the transition from article prose or acknowledgements into repeated bibliography-entry patterns.',
          'Exclude supplementary material, tables, captions, appendices, and non-reference prose if they appear after the reference list.',
          'Preserve the original order. For unnumbered styles, assign sequential numbers starting at 1.',
          'For citationMatchers, derive concise likely in-text forms from the entry, such as "Smith (2020)", "Smith et al. (2020)", "(Smith, 2020)", "Smith et al., 2020", or numeric labels for numbered styles.',
          'Do not warn merely because a provided block has no references. Leave warnings empty unless the whole bibliography is ambiguous or a reference cannot be split.',
          'Warnings must be short and user-friendly. Do not mention OCR block ids, internal keys, chunks, provided blocks, provided text, or implementation details in warnings.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: inferBibliographyRegion
            ? 'Infer the bibliography region inside this OCR end-of-manuscript context, then split it into individual bibliography entries.'
            : 'Split these OCR reference-list blocks into individual bibliography entries.',
          referenceBlocks
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral reference resolver timed out for this chunk.'
      : String(error?.message || error || 'Mistral reference resolver request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral reference resolver failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  const content = raw?.choices?.[0]?.message?.content;
  const resolved = parseJsonContent(content);
  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: resolved
  });
}

async function handleResolveCounts(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to resolve counted text.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  if (!blocks.length) {
    jsonResponse(res, { error: 'Missing OCR blocks for counted-text resolver.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: countedTextResolverSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You identify exactly what manuscript text should be counted for abstract and main-article word counts, plus front-matter authors, affiliations, and keywords.',
          'Return JSON only, conforming exactly to the schema.',
          'Use only copied text from the OCR blocks. Do not rewrite, summarize, or invent text.',
          'For abstract: identify the abstract-like section, including labels such as Abstract, Summary, or unlabeled abstract prose when clear. Exclude headings, keywords, research highlights, trial registration, author affiliations, correspondence, funding, tables, figures, captions, references, and supplement/back matter.',
          'If Keywords appears in the same OCR block after abstract prose, stop before Keywords and list it under excludedText.',
          'For article: identify counted main manuscript prose sections only. Prefer returning sourceBlockKeys instead of copying countedText; keep countedText empty unless one block must be split to exclude non-article text.',
          'Exclude abstract, keywords, references, bibliography, tables, figures, captions, supplements, appendices, acknowledgements, funding, conflicts, data availability, author contributions, headers, footers, and page/line numbers.',
          'For metadata.authors: copy only the manuscript author byline and return one item per author. When a byline joins people with "and", split the people into separate author items and remove footnote markers such as *, dagger symbols, superscripts, and correspondence symbols.',
          'For metadata.affiliations: copy distinct listed affiliation entries.',
          'For metadata.keywords: copy individual keywords from the manuscript keyword list. If the manuscript has no keyword list but an Editorial Manager or submission cover table has a Keywords field, use that field as backup and split it into individual keyword items. Return an empty keyword array only when neither manuscript nor cover metadata includes keywords.',
          'Use manuscript section titles where available. Keep output compact. Warnings must be short and user-friendly.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Resolve counted abstract/article text and front-matter author, affiliation, and keyword counts from these OCR blocks.',
          blocks: blocks.slice(0, 180).map((block) => ({
            blockKey: String(block.blockKey || ''),
            pageNumber: Number(block.pageNumber || 0) || 0,
            type: String(block.type || ''),
            text: String(block.text || '').slice(0, 2500)
          }))
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral counted-text resolver timed out.'
      : String(error?.message || error || 'Mistral counted-text resolver request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral counted-text resolver failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function handleResolveDisplayItems(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to resolve table and figure details.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const displayItems = Array.isArray(body.displayItems) ? body.displayItems : [];
  const bodyBlocks = Array.isArray(body.bodyBlocks) ? body.bodyBlocks : [];
  if (!displayItems.length) {
    jsonResponse(res, { error: 'Missing OCR table/figure items.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: displayItemResolverSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You classify OCR tables and figures and identify body-text citations to them.',
          'Return JSON only, conforming exactly to the schema.',
          'Use only the supplied OCR text and block keys. Do not invent display items or citation locations.',
          'For isManuscriptItem, return true only for tables and figures that are part of the submitted manuscript or article.',
          'A manuscript table must be supported by an explicit table label/caption in the item text or by a body-text citation to that table. If OCR marks a chart, plot, spectrum, waveform, axis-label graphic, or image-derived text block as kind "table", do not keep it as a table unless it is explicitly labeled/cited as a table.',
          'If a table-shaped OCR item is actually a chart, plot, spectrum, waveform, or image panel and it is part of the manuscript, reclassify kind as "figure" when the supplied text or body context supports that; otherwise set isManuscriptItem false with a short exclusionReason.',
          'Use fallback labels such as "Table on page 12" only for true manuscript tables with clear table evidence. Do not use a fallback page label to promote an unlabeled OCR artifact into a manuscript table.',
          'Exclude Editorial Manager, submission system, peer-review system, journal tracking, cover-page metadata, author-information forms, checklist/admin, and manuscript-processing tables even if OCR marks them as tables.',
          'Also exclude tables or figures that belong only to supplement/back matter unless they are clearly part of the manuscript body.',
          'For each manuscript table or figure, return a concise label such as "Table 1" or "Figure 2" when visible; otherwise use a short descriptive label.',
          'For citationOccurrences, find copied body-text passages that cite the item, such as "Table 1", "(Table 1)", "Figure 2", "Fig. 2", or textual equivalents.',
          'Do not use references from captions, reference lists, Editorial Manager cover pages, table contents, figure contents, or administrative metadata as body-text citations.',
          'Warnings must be short and user-friendly. Do not mention OCR block ids, chunks, schemas, or implementation details.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Classify these OCR table/figure items and find their body-text citation uses.',
          displayItems: displayItems.slice(0, 80).map((item) => ({
            itemId: String(item.itemId || ''),
            kind: String(item.kind || ''),
            sourceBlockKey: String(item.sourceBlockKey || ''),
            pageNumber: Number(item.pageNumber || 0) || 0,
            label: String(item.label || '').slice(0, 240),
            text: String(item.text || '').slice(0, 2500)
          })),
          bodyBlocks: bodyBlocks.slice(0, 220).map((block) => ({
            blockKey: String(block.blockKey || ''),
            pageNumber: Number(block.pageNumber || 0) || 0,
            type: String(block.type || ''),
            text: String(block.text || '').slice(0, 1800)
          }))
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral table/figure resolver timed out.'
      : String(error?.message || error || 'Mistral table/figure resolver request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral table/figure resolver failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function handleAnnotateDocument(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to annotate the document.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  if (!blocks.length) {
    jsonResponse(res, { error: 'Missing OCR blocks for document annotation.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: documentAnnotationSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You create a source-grounded manuscript annotation from OCR blocks.',
          'Return JSON only, conforming exactly to the schema.',
          'Use only supplied OCR block text and resolver context. Do not invent manuscript content.',
          'For title, front matter, abstract, article sections, references, tables, and figures, copy exact source text snippets and block keys when available.',
          'Use resolver context as supporting evidence when it is supplied, but if it conflicts with OCR text, prefer exact OCR source text and add a short warning.',
          'Keep the annotation concise: article countedText values should be short representative snippets, not full sections.',
          'Return at most 8 article sections, at most 12 reference entries, at most 24 display items, and at most 24 quoteAnchors.',
          'Leave citationOccurrences arrays empty unless a directly supplied resolver context already contains a short citation occurrence.',
          'quoteAnchors should contain concise exact quotes that later checks can use for PDF/HTML jump links, especially for declarations such as ethics approval, consent, conflicts of interest, funding, data availability, protocol registration, and author contributions when those statements are present.',
          'Warnings must be short and user-friendly. Do not mention schemas, prompts, or implementation details.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Annotate this manuscript for later guideline checks and source-grounded navigation.',
          blocks: blocks.slice(0, 120).map((block) => ({
            blockKey: String(block.blockKey || ''),
            pageNumber: Number(block.pageNumber || 0) || 0,
            type: String(block.type || ''),
            text: String(block.text || '').slice(0, 900)
          })),
          resolverContext: body.resolverContext || {}
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral document annotation timed out.'
      : String(error?.message || error || 'Mistral document annotation request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral document annotation failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function handleMatchGuidelines(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to match reporting guidelines.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const catalog = Array.isArray(body.catalog) ? body.catalog : [];
  const annotation = body.documentAnnotation && typeof body.documentAnnotation === 'object' ? body.documentAnnotation : null;
  if (!annotation) {
    jsonResponse(res, { error: 'Missing document annotation for guideline matching.' }, 400);
    return;
  }
  if (!catalog.length) {
    jsonResponse(res, { error: 'Missing reporting guideline catalog.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: guidelineMatchSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You match manuscripts to reporting guidelines from a supplied catalog.',
          'Return JSON only, conforming exactly to the schema.',
          'Use only the supplied document annotation and catalog. Do not invent guideline ids.',
          'Prefer high-confidence matches when manuscript design, title, abstract, sections, or keywords clearly indicate a guideline.',
          'Use sourceBlockKey and anchorQuote from the annotation when possible.',
          'Return only relevant matches. Leave matches empty when none are supported.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Rank relevant reporting guidelines for this manuscript.',
          documentAnnotation: annotation,
          catalog: catalog.slice(0, 40)
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral guideline matching timed out.'
      : String(error?.message || error || 'Mistral guideline matching request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral guideline matching failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function handleEvaluateEssentialGuidelines(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to evaluate Essential guidelines.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const guides = Array.isArray(body.guides) ? body.guides : [];
  const annotation = body.documentAnnotation && typeof body.documentAnnotation === 'object' ? body.documentAnnotation : null;
  if (!annotation) {
    jsonResponse(res, { error: 'Missing document annotation for Essential guideline evaluation.' }, 400);
    return;
  }
  if (!guides.length) {
    jsonResponse(res, { error: 'Missing Essential guidelines.' }, 400);
    return;
  }

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0,
    response_format: essentialGuidelineEvaluationSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You evaluate Essential manuscript guideline items from a supplied document annotation.',
          'Return JSON only, conforming exactly to the schema.',
          'Evaluate every supplied item. Use only the supplied document annotation and guideline text.',
          'Do not infer that an item is present unless the annotation contains direct support.',
          'Use present when the requirement is clearly satisfied, warning when partially or ambiguously supported, absent when expected information is missing, optional when an optional item is not reported but not required, and na when the item is not applicable.',
          'For each supported item, copy one or two concise exact source quotes from the annotation and include sourceBlockKey when available.',
          'Messages should be useful to authors and reviewers, concise, and specific.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Evaluate the Essential guideline items for this manuscript.',
          documentAnnotation: annotation,
          guides: guides.slice(0, 10).map((guide) => ({
            id: String(guide.id || ''),
            name: String(guide.name || ''),
            description: String(guide.description || ''),
            items: (Array.isArray(guide.items) ? guide.items : []).slice(0, 40).map((item) => ({
              id: String(item.id || ''),
              label: String(item.label || item.id || ''),
              requirement: String(item.requirement || ''),
              optional: Boolean(item.optional)
            }))
          }))
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral Essential guideline evaluation timed out.'
      : String(error?.message || error || 'Mistral Essential guideline evaluation request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral Essential guideline evaluation failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function handleChat(req, res) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) {
    jsonResponse(res, { error: 'MISTRAL_API_KEY is required to chat with a manuscript.' }, 500);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Invalid request body.') }, 400);
    return;
  }

  const question = String(body.question || '').trim();
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  if (!question) {
    jsonResponse(res, { error: 'Missing chat question.' }, 400);
    return;
  }
  if (!blocks.length) {
    jsonResponse(res, { error: 'No manuscript context is available for chat.' }, 400);
    return;
  }

  const contextBlocks = blocks.slice(0, 160).map((block) => ({
    blockKey: String(block.blockKey || ''),
    pageNumber: Number(block.pageNumber || 0) || 0,
    type: String(block.type || ''),
    text: String(block.text || '').replace(/\s+/g, ' ').trim().slice(0, 2500)
  })).filter((block) => block.text);

  const history = (Array.isArray(body.history) ? body.history : []).slice(-6).map((message) => ({
    role: String(message.role || '') === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || '').slice(0, 1200)
  })).filter((message) => message.content);

  const startedAt = Date.now();
  const requestBody = {
    model: MISTRAL_CHAT_MODEL,
    temperature: 0.1,
    response_format: groundedChatSchema(),
    messages: [
      {
        role: 'system',
        content: [
          'You are an academic manuscript assistant.',
          'Answer using only the supplied OCR manuscript blocks.',
          'Do not use outside knowledge or assumptions.',
          'Every substantive claim must be supported by inline markers like [1].',
          'Every citation quote must be copied verbatim from the supplied block text.',
          'If the manuscript context does not contain enough information, say that plainly and cite the closest relevant quote explaining the limitation.',
          'Return JSON only and conform exactly to the schema.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Answer the user question using only these OCR manuscript blocks. Include citation markers in the answer and exact supporting quotes in citations.',
          question,
          previousMessages: history,
          manuscriptBlocks: contextBlocks
        })
      }
    ]
  };

  let response;
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
    response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Mistral manuscript chat timed out.'
      : String(error?.message || error || 'Mistral manuscript chat request failed.');
    jsonResponse(res, { error: message }, error?.name === 'TimeoutError' ? 504 : 502);
    return;
  }

  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = null;
  }

  if (!response.ok) {
    jsonResponse(res, {
      error: raw?.error?.message || raw?.message || text || `Mistral manuscript chat failed (${response.status}).`,
      elapsedMs: Date.now() - startedAt,
      model: MISTRAL_CHAT_MODEL
    }, response.status);
    return;
  }

  jsonResponse(res, {
    elapsedMs: Date.now() - startedAt,
    model: raw?.model || MISTRAL_CHAT_MODEL,
    usage: raw?.usage || null,
    result: parseJsonContent(raw?.choices?.[0]?.message?.content)
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const rootEntry = [...STATIC_ROOTS.entries()].find(([prefix]) => pathname.startsWith(prefix));
  const root = rootEntry ? rootEntry[1] : PUBLIC_ROOT;
  const relativePath = rootEntry ? pathname.slice(rootEntry[0].length) : pathname.slice(1);
  const resolved = resolve(root, relativePath || 'index.html');
  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const content = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[extname(resolved)] || 'application/octet-stream'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/ocr') {
      await handleOcr(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ocr-count-annotation') {
      await handleOcrCountAnnotation(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/resolve-references') {
      await handleResolveReferences(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/resolve-counts') {
      await handleResolveCounts(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/resolve-display-items') {
      await handleResolveDisplayItems(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/annotate-document') {
      await handleAnnotateDocument(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/match-guidelines') {
      await handleMatchGuidelines(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/evaluate-essential-guidelines') {
      await handleEvaluateEssentialGuidelines(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      await handleChat(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (error) {
    jsonResponse(res, { error: String(error?.message || error || 'Unexpected server error.') }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`deskreview-mistral-2 listening on http://127.0.0.1:${PORT}`);
  logStartupDiagnostics();
});
