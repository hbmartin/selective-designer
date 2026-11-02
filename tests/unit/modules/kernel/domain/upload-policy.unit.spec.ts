import { errorValue, okValue } from '@tests/support/result';
import { describe, expect, it } from 'vitest';

import { toGeneratedId } from '@/modules/kernel/domain/ids';
import {
  createUploadObjectKey,
  isAcceptedUploadType,
  isUploadPurpose,
  objectKeyMatchesPurpose,
  uploadPurposePolicies,
  uploadPurposes,
} from '@/modules/kernel/domain/upload-policy';
import { unwrapParseResult } from '@/modules/kernel/testing';

const id = unwrapParseResult(toGeneratedId('cuid123'));

describe('upload policy', () => {
  it('builds server-decided keys from purpose, id and MIME', () => {
    expect(
      okValue(
        createUploadObjectKey({
          purpose: 'base_image',
          id,
          fileType: 'image/jpeg',
        })
      )
    ).toBe('base-images/cuid123.jpg');
    expect(
      okValue(
        createUploadObjectKey({
          purpose: 'region_mask',
          id,
          fileType: ' IMAGE/PNG ',
        })
      )
    ).toBe('region-masks/cuid123.png');
  });

  it('rejects types outside the purpose allowlist', () => {
    const rejected = createUploadObjectKey({
      purpose: 'region_mask',
      id,
      fileType: 'image/jpeg',
    });
    expect(errorValue(rejected)).toEqual({
      type: 'upload_file_type_not_allowed',
      purpose: 'region_mask',
      fileType: 'image/jpeg',
    });
    expect(
      createUploadObjectKey({
        purpose: 'base_image',
        id,
        fileType: 'text/html',
      }).isError()
    ).toBe(true);
  });

  it('keeps every purpose image-only with a positive size limit', () => {
    for (const purpose of uploadPurposes) {
      const policy = uploadPurposePolicies[purpose];
      expect(policy.maxFileSizeBytes).toBeGreaterThan(0);
      for (const type of policy.acceptedFileTypes) {
        expect(type.startsWith('image/')).toBe(true);
        expect(isAcceptedUploadType(purpose, type)).toBe(true);
      }
    }
  });

  it('matches keys back to the purpose that minted them', () => {
    expect(
      objectKeyMatchesPurpose('base-images/cuid123.png', 'base_image')
    ).toBe(true);
    expect(
      objectKeyMatchesPurpose('base-images/cuid123.png', 'region_mask')
    ).toBe(false);
    expect(
      objectKeyMatchesPurpose('base-images/../secrets.png', 'base_image')
    ).toBe(false);
    expect(isUploadPurpose('edit_mask')).toBe(true);
    expect(isUploadPurpose('book_cover')).toBe(false);
  });
});
